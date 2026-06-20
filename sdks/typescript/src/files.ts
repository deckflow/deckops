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
      if (!this.isNodeRuntime()) {
        throw new Error('String file paths are only supported in Node.js. Use File, Blob, Uint8Array, or ArrayBuffer in browsers.');
      }
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const data = await fs.readFile(input);
      const hash = options.hash ?? this.calculateMD5(data);
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
      const bytes = new Uint8Array(await input.arrayBuffer());
      return {
        name,
        bytes: input.size,
        hash: options.hash ?? this.calculateMD5(bytes),
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
      hash: options.hash ?? this.calculateMD5(data),
      data,
      chunkSize,
    };
  }

  private isBlob(input: UploadInput): input is Blob {
    return typeof Blob !== 'undefined' && input instanceof Blob;
  }

  private isNodeRuntime(): boolean {
    return typeof process !== 'undefined' && process.versions?.node != null;
  }

  private calculateMD5(data: Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const originalLength = bytes.byteLength;
    const bitLength = originalLength * 8;
    const paddedLength = (((originalLength + 8) >>> 6) + 1) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[originalLength] = 0x80;

    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, bitLength >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    const s = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const k = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000));

    for (let offset = 0; offset < paddedLength; offset += 64) {
      const m = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
      let a = a0;
      let b = b0;
      let c = c0;
      let d = d0;

      for (let i = 0; i < 64; i += 1) {
        let f: number;
        let g: number;
        if (i < 16) {
          f = (b & c) | (~b & d);
          g = i;
        } else if (i < 32) {
          f = (d & b) | (~d & c);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          f = b ^ c ^ d;
          g = (3 * i + 5) % 16;
        } else {
          f = c ^ (b | ~d);
          g = (7 * i) % 16;
        }

        const temp = d;
        const sum = (a + f + k[i]! + m[g]!) >>> 0;
        d = c;
        c = b;
        b = (b + this.leftRotate(sum, s[i]!)) >>> 0;
        a = temp;
      }

      a0 = (a0 + a) >>> 0;
      b0 = (b0 + b) >>> 0;
      c0 = (c0 + c) >>> 0;
      d0 = (d0 + d) >>> 0;
    }

    return [a0, b0, c0, d0].map((word) => this.wordToHex(word)).join('');
  }

  private leftRotate(value: number, shift: number): number {
    return ((value << shift) | (value >>> (32 - shift))) >>> 0;
  }

  private wordToHex(word: number): string {
    return [0, 8, 16, 24]
      .map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, '0'))
      .join('');
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
    if (typeof globalThis.FormData === 'undefined' || typeof globalThis.Blob === 'undefined') {
      throw new Error('FormData and Blob are required for local uploads in this runtime');
    }

    const form = new FormData();
    const blob = this.isBlob(data) ? data : new Blob([this.toArrayBuffer(data)]);
    form.append('file', blob, name);
    return { body: form, headers: {} };
  }

  private toArrayBuffer(data: Uint8Array): ArrayBuffer {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
  }
}
