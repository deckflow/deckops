import axios from 'axios';
import pLimit from 'p-limit';
import type { HttpClient } from './http-client.js';
import {
  DEFAULT_CHUNK_SIZE,
  type AuthInfo,
  type FileUploadResult,
  type PartAuth,
  type PartResult,
  type RequestUploadParams,
  type UploadAuthResponse,
  type UploadInput,
  type UploadOptions,
} from './types.js';

type NormalizedUpload = {
  name: string;
  bytes: number;
  hash: string;
  data: Uint8Array | Blob;
  chunkSize: number;
};

export class FilesApi {
  constructor(private readonly http: HttpClient) {}

  async requestUpload(params: RequestUploadParams): Promise<UploadAuthResponse> {
    const spaceId = this.requireSpaceId(params.spaceId);
    const res = await this.http.post<UploadAuthResponse>(`/spaces/${encodeURIComponent(spaceId)}/file/auth`, {
      name: params.name,
      bytes: params.bytes,
      hash: params.hash,
      chunkSize: params.chunkSize ?? DEFAULT_CHUNK_SIZE,
    });
    return res.data;
  }

  async upload(input: UploadInput, options: UploadOptions = {}): Promise<FileUploadResult> {
    const normalized = await this.normalizeInput(input, options);
    const auth = await this.requestUpload({
      spaceId: options.spaceId,
      name: normalized.name,
      bytes: normalized.bytes,
      hash: normalized.hash,
      chunkSize: normalized.chunkSize,
    });

    if (!auth.auth) {
      options.onProgress?.(1);
      return {
        id: auth.id,
        key: auth.key,
        name: normalized.name,
        bytes: normalized.bytes,
        hash: normalized.hash,
      };
    }

    if (auth.multipart) {
      await this.uploadMultipart(normalized, auth, options.onProgress);
    } else {
      await this.uploadSingle(normalized, auth, options.onProgress);
    }

    return {
      id: auth.id,
      key: auth.key,
      name: normalized.name,
      bytes: normalized.bytes,
      hash: normalized.hash,
    };
  }

  private requireSpaceId(spaceId?: string): string {
    const value = spaceId ?? this.http.spaceId;
    if (!value) {
      throw new Error('spaceId is required');
    }
    return value;
  }

  private async normalizeInput(input: UploadInput, options: UploadOptions): Promise<NormalizedUpload> {
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

    if (typeof input === 'string') {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const data = await fs.readFile(input);
      const hash = options.hash ?? (await this.calculateMD5(data));
      return {
        name: options.name ?? path.basename(input),
        bytes: data.byteLength,
        hash,
        data,
        chunkSize,
      };
    }

    if (this.isBlob(input)) {
      const name = options.name ?? (input as Blob & { name?: string }).name;
      if (!name) {
        throw new Error('name is required when uploading a Blob without a name');
      }
      const hash = options.hash;
      if (!hash) {
        throw new Error('hash is required when uploading Blob/File input');
      }
      return {
        name,
        bytes: input.size,
        hash,
        data: input,
        chunkSize,
      };
    }

    const data = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    const name = options.name;
    if (!name) {
      throw new Error('name is required when uploading binary input');
    }

    return {
      name,
      bytes: data.byteLength,
      hash: options.hash ?? (await this.calculateMD5(data)),
      data,
      chunkSize,
    };
  }

  private isBlob(input: UploadInput): input is Blob {
    return typeof Blob !== 'undefined' && input instanceof Blob;
  }

  private async calculateMD5(data: Uint8Array): Promise<string> {
    const crypto = await import('node:crypto');
    return crypto.createHash('md5').update(data).digest('hex');
  }

  private async uploadSingle(
    file: NormalizedUpload,
    authResponse: UploadAuthResponse,
    onProgress?: (percentage: number) => void
  ): Promise<void> {
    const { auth, platform } = authResponse;
    if (!auth) {
      throw new Error('Missing auth in upload response');
    }

    const headers = this.authHeaders(auth);
    if (platform === 'oss') {
      await axios.put(auth.url, file.data, { headers });
    } else {
      const { body, headers: formHeaders } = await this.createFormBody(file.name, file.data);
      await axios.put(auth.url, body, {
        headers: {
          ...headers,
          ...formHeaders,
        },
      });
    }

    onProgress?.(1);
  }

  private async uploadMultipart(
    file: NormalizedUpload,
    authResponse: UploadAuthResponse,
    onProgress?: (percentage: number) => void
  ): Promise<void> {
    const { auth, multipartPartAuths, multipartPartSize, platform } = authResponse;
    if (!auth) {
      throw new Error('Missing auth in upload response');
    }
    if (!multipartPartAuths?.length) {
      throw new Error('Multipart upload authorization missing');
    }

    const chunkSize = multipartPartSize ?? file.chunkSize;
    const partCount = multipartPartAuths.length;
    const progress: number[] = new Array<number>(partCount).fill(0);
    const updateProgress = () => {
      onProgress?.((0.95 * progress.reduce((a, b) => a + b, 0)) / partCount);
    };

    const data = this.isBlob(file.data) ? new Uint8Array(await file.data.arrayBuffer()) : file.data;
    const limit = pLimit(5);
    const parts = await Promise.all(
      multipartPartAuths.map((partAuth, index) =>
        limit(async () => {
          const result = await this.uploadPart(file.name, data, partAuth, index, chunkSize, platform);
          progress[index] = 1;
          updateProgress();
          return result;
        })
      )
    );

    parts.sort((a, b) => a.partNumber - b.partNumber);
    await this.completeMultipart(auth, platform, parts);
    onProgress?.(1);
  }

  private async uploadPart(
    name: string,
    data: Uint8Array,
    partAuth: PartAuth,
    partIndex: number,
    chunkSize: number,
    platform: string
  ): Promise<PartResult> {
    const chunk = data.slice(partIndex * chunkSize, (partIndex + 1) * chunkSize);
    const headers = this.authHeaders(partAuth);

    if (platform === 'oss') {
      const response = await axios.put(partAuth.url, chunk, { headers });
      let etag = String(response.headers.etag || '');
      if (etag.startsWith('"') && etag.endsWith('"')) {
        etag = etag.slice(1, -1);
      }
      return { partNumber: partIndex + 1, eTag: etag };
    }

    const { body, headers: formHeaders } = await this.createFormBody(name, chunk);
    const response = await axios.put<unknown>(partAuth.url, body, {
      headers: {
        ...headers,
        ...formHeaders,
      },
    });
    const responseData = response.data as { hash?: unknown };
    return { partNumber: partIndex + 1, hash: String(responseData.hash ?? '') };
  }

  private async completeMultipart(auth: AuthInfo, platform: string, parts: PartResult[]): Promise<void> {
    const headers = this.authHeaders(auth);
    if (platform === 'oss') {
      const xmlParts = parts.map(
        (part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.eTag}</ETag></Part>`
      );
      await axios.post(auth.url, `<CompleteMultipartUpload>${xmlParts.join('')}</CompleteMultipartUpload>`, {
        headers,
      });
      return;
    }

    await axios.post(auth.url, { parts }, { headers: { ...headers, 'Content-Type': 'application/json' } });
  }

  private authHeaders(auth: AuthInfo | PartAuth): Record<string, string> {
    const headers: Record<string, string> = { ...auth.headers };
    if (auth.Authorization) {
      headers.Authorization = auth.Authorization;
    }
    return headers;
  }

  private async createFormBody(
    name: string,
    data: Uint8Array | Blob
  ): Promise<{ body: unknown; headers: Record<string, string> }> {
    if (typeof globalThis.FormData !== 'undefined') {
      const form = new FormData();
      const blob = this.isBlob(data) ? data : new Blob([this.toArrayBuffer(data)]);
      form.append('file', blob, name);
      return { body: form, headers: {} };
    }

    const { default: NodeFormData } = await import('form-data');
    const form = new NodeFormData();
    form.append('file', this.isBlob(data) ? Buffer.from(await data.arrayBuffer()) : Buffer.from(data), name);
    return { body: form, headers: form.getHeaders() as Record<string, string> };
  }

  private toArrayBuffer(data: Uint8Array): ArrayBuffer {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
  }
}
