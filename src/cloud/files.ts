import axios from 'axios';
import pLimit from 'p-limit';
import { throwIfAborted, withSignal } from './abort.js';
import type { HttpClient } from './http-client.js';
import type { DeckRuntime } from './runtime.js';
import {
  DEFAULT_CHUNK_SIZE,
  type AuthInfo,
  type FileUploadResult,
  type PartAuth,
  type PartResult,
  type PreparedUpload,
  type RequestUploadParams,
  type UploadAuthResponse,
  type UploadInput,
  type UploadOptions,
} from './contracts.js';

export class FilesApi {
  constructor(private readonly http: HttpClient, private readonly runtime: DeckRuntime) {}

  async requestUpload(params: RequestUploadParams): Promise<UploadAuthResponse> {
    throwIfAborted(params.signal);
    const spaceId = await this.http.resolveSpaceId(params.spaceId, params.signal);
    if (!spaceId) {
      throw new Error('spaceId is required for file uploads');
    }
    const res = await this.http.post<UploadAuthResponse>(`/spaces/${encodeURIComponent(spaceId)}/file/auth`, {
      name: params.name,
      bytes: params.bytes,
      hash: params.hash,
      chunkSize: params.chunkSize ?? DEFAULT_CHUNK_SIZE,
    }, { signal: params.signal });
    return res.data;
  }

  /** Normalize a local input into bytes/name/hash without uploading. */
  async prepare(input: UploadInput, options: UploadOptions = {}): Promise<PreparedUpload> {
    throwIfAborted(options.signal);
    const result = await this.normalizeInput(input, options);
    throwIfAborted(options.signal);
    return result;
  }

  async upload(input: UploadInput, options: UploadOptions = {}): Promise<FileUploadResult> {
    const normalized = await this.prepare(input, options);
    return await this.uploadPrepared(normalized, options);
  }

  async uploadPrepared(file: PreparedUpload, options: UploadOptions = {}): Promise<FileUploadResult> {
    throwIfAborted(options.signal);
    try {
      return await this.performUpload(file, options);
    } catch (error) {
      throwIfAborted(options.signal);
      throw error;
    }
  }

  private async performUpload(file: PreparedUpload, options: UploadOptions): Promise<FileUploadResult> {
    const auth = await this.requestUpload({
      signal: options.signal,
      spaceId: options.spaceId,
      name: file.name,
      bytes: file.bytes,
      hash: file.hash,
      chunkSize: file.chunkSize,
    });
    throwIfAborted(options.signal);

    if (!auth.auth) {
      options.onProgress?.(1);
      return {
        id: auth.id,
        key: auth.key,
        name: file.name,
        bytes: file.bytes,
        hash: file.hash,
      };
    }

    if (auth.multipart) {
      await this.uploadMultipart(file, auth, options.onProgress, options.signal);
    } else {
      await this.uploadSingle(file, auth, options.onProgress, options.signal);
    }

    throwIfAborted(options.signal);
    return {
      id: auth.id,
      key: auth.key,
      name: file.name,
      bytes: file.bytes,
      hash: file.hash,
    };
  }

  private async normalizeInput(input: UploadInput, options: UploadOptions): Promise<PreparedUpload> {
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

    if (typeof input === 'string') {
      if (!this.runtime.readFile) {
        throw new Error('String file paths are only supported in Node.js. Use File, Blob, Uint8Array, or ArrayBuffer in browsers.');
      }
      const { data, name } = await this.runtime.readFile(input, options.signal);
      const hash = options.hash ?? this.calculateMD5(data);
      return {
        name: options.name ?? name,
        bytes: data.byteLength,
        hash,
        data,
        chunkSize,
      };
    }

    if (this.isBlob(input)) {
      const name = options.name ?? (input as Blob & { name?: (string) | undefined }).name;
      if (!name) {
        throw new Error('name is required when uploading a Blob without a name');
      }
      const bytes = new Uint8Array(await withSignal(input.arrayBuffer(), options.signal));
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

  private isBlob(input: UploadInput | Blob | Uint8Array): input is Blob {
    return typeof Blob !== 'undefined' && input instanceof Blob;
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
    file: PreparedUpload,
    authResponse: UploadAuthResponse,
    onProgress?: (percentage: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const { auth, platform } = authResponse;
    if (!auth) {
      throw new Error('Missing auth in upload response');
    }

    const headers = this.authHeaders(auth);
    if (platform === 'oss') {
      await axios.put(auth.url, file.data, { headers, ...(signal ? { signal } : {}) });
    } else {
      const { body, headers: formHeaders } = await this.createFormBody(file.name, file.data);
      await axios.put(auth.url, body, {
        ...(signal ? { signal } : {}),
        headers: {
          ...headers,
          ...formHeaders,
        },
      });
    }

    throwIfAborted(signal);
    onProgress?.(1);
  }

  private async uploadMultipart(
    file: PreparedUpload,
    authResponse: UploadAuthResponse,
    onProgress?: (percentage: number) => void,
    signal?: AbortSignal
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

    const data = this.isBlob(file.data)
      ? new Uint8Array(await withSignal(file.data.arrayBuffer(), signal)) : file.data;
    const limit = pLimit(5);
    const parts = await Promise.all(
      multipartPartAuths.map((partAuth, index) =>
        limit(async () => {
          throwIfAborted(signal);
          const result = await this.uploadPart(file.name, data, partAuth, index, chunkSize, platform, signal);
          progress[index] = 1;
          updateProgress();
          return result;
        })
      )
    );

    parts.sort((a, b) => a.partNumber - b.partNumber);
    throwIfAborted(signal);
    await this.completeMultipart(auth, platform, parts, signal);
    onProgress?.(1);
  }

  private async uploadPart(
    name: string,
    data: Uint8Array,
    partAuth: PartAuth,
    partIndex: number,
    chunkSize: number,
    platform: string,
    signal?: AbortSignal
  ): Promise<PartResult> {
    const chunk = data.slice(partIndex * chunkSize, (partIndex + 1) * chunkSize);
    const headers = this.authHeaders(partAuth);

    if (platform === 'oss') {
      const response = await axios.put(partAuth.url, chunk, { headers, ...(signal ? { signal } : {}) });
      let etag = String(response.headers.etag || '');
      if (etag.startsWith('"') && etag.endsWith('"')) {
        etag = etag.slice(1, -1);
      }
      return { partNumber: partIndex + 1, eTag: etag };
    }

    const { body, headers: formHeaders } = await this.createFormBody(name, chunk);
    const response = await axios.put<unknown>(partAuth.url, body, {
      ...(signal ? { signal } : {}),
      headers: {
        ...headers,
        ...formHeaders,
      },
    });
    const responseData = response.data as { hash?: (unknown) | undefined };
    return { partNumber: partIndex + 1, hash: String(responseData.hash ?? '') };
  }

  private async completeMultipart(auth: AuthInfo, platform: string, parts: PartResult[], signal?: AbortSignal): Promise<void> {
    const headers = this.authHeaders(auth);
    if (platform === 'oss') {
      const xmlParts = parts.map(
        (part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.eTag}</ETag></Part>`
      );
      await axios.post(auth.url, `<CompleteMultipartUpload>${xmlParts.join('')}</CompleteMultipartUpload>`, {
        headers, ...(signal ? { signal } : {}),
      });
      return;
    }

    await axios.post(auth.url, { parts }, { headers: { ...headers, 'Content-Type': 'application/json' }, ...(signal ? { signal } : {}) });
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
