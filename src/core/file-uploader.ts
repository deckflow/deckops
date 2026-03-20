/**
 * File uploader for deckflow
 */

import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import pLimit from 'p-limit';
import FormData from 'form-data';
import { APIClient } from './api-client.js';
import type { UploadAuthResponse, FileDigest, PartResult, PartAuth, AuthInfo } from '../types/api.js';
import { CHUNK_SIZE } from '../utils/constants.js';

export class FileUploader {
  constructor(private apiClient: APIClient) {}

  /**
   * Upload a file and return its file ID
   */
  async uploadFile(
    spaceId: string,
    filePath: string,
    progressCallback?: (percentage: number) => void
  ): Promise<string> {
    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    // Calculate file digest
    const fileDigest = await this.getFileDigest(filePath);

    // Get upload authorization
    const authResponse = await this.apiClient.requestFileUpload(
      spaceId,
      fileDigest.name,
      fileDigest.bytes,
      fileDigest.hash,
      fileDigest.chunkSize
    );

    // Check if file already exists (deduplication)
    if (!authResponse.auth) {
      return authResponse.id;
    }

    // Perform upload based on multipart flag
    if (authResponse.multipart) {
      return this.uploadMultipart(filePath, authResponse, progressCallback);
    } else {
      return this.uploadSingle(filePath, authResponse, progressCallback);
    }
  }

  /**
   * Calculate file digest (MD5, size, etc.)
   */
  private async getFileDigest(filePath: string): Promise<FileDigest> {
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;
    const fileHash = await APIClient.calculateMD5(filePath);

    return {
      name: path.basename(filePath),
      bytes: fileSize,
      hash: fileHash,
      chunkSize: CHUNK_SIZE,
    };
  }

  /**
   * Upload file as single request (non-multipart)
   */
  private async uploadSingle(
    filePath: string,
    authResponse: UploadAuthResponse,
    progressCallback?: (percentage: number) => void
  ): Promise<string> {
    const { auth, platform } = authResponse;
    if (!auth) throw new Error('Missing auth in upload response');

    const fileData = await fs.readFile(filePath);

    const url = auth.url;
    const headers: Record<string, string> = { ...auth.headers };
    if (auth.Authorization) {
      headers['Authorization'] = auth.Authorization;
    }

    if (platform === 'oss') {
      // Direct PUT for OSS
      await axios.put(url, fileData, { headers });
    } else {
      // Form data for local storage
      const form = new FormData();
      form.append('file', fileData, path.basename(filePath));

      await axios.put(url, form, {
        headers: {
          ...headers,
          ...form.getHeaders(),
        },
      });
    }

    progressCallback?.(1.0);
    return authResponse.id;
  }

  /**
   * Upload file with multipart (chunked) upload
   */
  private async uploadMultipart(
    filePath: string,
    authResponse: UploadAuthResponse,
    progressCallback?: (percentage: number) => void
  ): Promise<string> {
    const { platform, multipartPartAuths, multipartPartSize, auth } = authResponse;

    if (!multipartPartAuths || multipartPartAuths.length === 0) {
      throw new Error('Multipart upload authorization missing');
    }

    if (!auth) throw new Error('Missing auth in upload response');

    const chunkSize = multipartPartSize || CHUNK_SIZE;
    const partCount = multipartPartAuths.length;

    // Track progress for each part
    const progressPercentages = new Array(partCount).fill(0);

    const updateProgress = () => {
      if (progressCallback) {
        // 95% for upload, 5% for completion
        const overall = 0.95 * progressPercentages.reduce((a, b) => a + b, 0) / partCount;
        progressCallback(overall);
      }
    };

    // Upload parts with concurrency limit (max 5)
    const limit = pLimit(5);
    const uploadPromises = multipartPartAuths.map((partAuth, index) =>
      limit(() =>
        this.uploadPart(filePath, partAuth, index, chunkSize, platform).then((result) => {
          progressPercentages[index] = 1.0;
          updateProgress();
          return result;
        })
      )
    );

    const parts = await Promise.all(uploadPromises);

    // Sort parts by partNumber
    parts.sort((a, b) => a.partNumber - b.partNumber);

    // Complete multipart upload
    await this.completeMultipart(auth, platform, parts);

    progressCallback?.(1.0);
    return authResponse.id;
  }

  /**
   * Upload a single part of multipart upload
   */
  private async uploadPart(
    filePath: string,
    partAuth: PartAuth,
    partIndex: number,
    chunkSize: number,
    platform: string
  ): Promise<PartResult> {
    const fileHandle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(chunkSize);

    try {
      const offset = partIndex * chunkSize;
      const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, offset);
      const chunkData = buffer.slice(0, bytesRead);

      const url = partAuth.url;
      const headers: Record<string, string> = { ...partAuth.headers };
      if (partAuth.Authorization) {
        headers['Authorization'] = partAuth.Authorization;
      }

      if (platform === 'oss') {
        // Direct PUT for OSS
        const response = await axios.put(url, chunkData, { headers });

        // Get ETag from response
        let etag = response.headers.etag || '';
        // Remove quotes if present
        if (etag.startsWith('"') && etag.endsWith('"')) {
          etag = etag.slice(1, -1);
        }

        return {
          partNumber: partIndex + 1,
          eTag: etag,
        };
      } else {
        // Form data for local storage
        const form = new FormData();
        form.append('file', chunkData, path.basename(filePath));

        const response = await axios.put(url, form, {
          headers: {
            ...headers,
            ...form.getHeaders(),
          },
        });

        return {
          partNumber: partIndex + 1,
          hash: response.data.hash as string,
        };
      }
    } finally {
      await fileHandle.close();
    }
  }

  /**
   * Complete multipart upload
   */
  private async completeMultipart(
    auth: AuthInfo,
    platform: string,
    parts: PartResult[]
  ): Promise<void> {
    const url = auth.url;
    const headers: Record<string, string> = { ...auth.headers };
    if (auth.Authorization) {
      headers['Authorization'] = auth.Authorization;
    }

    if (platform === 'oss') {
      // Build XML body for OSS
      const xmlParts = parts.map(
        (part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.eTag}</ETag></Part>`
      );
      const body = `<CompleteMultipartUpload>${xmlParts.join('')}</CompleteMultipartUpload>`;

      // IMPORTANT: Do NOT set Content-Type for OSS complete request
      await axios.post(url, body, { headers });
    } else {
      // JSON body for local storage
      headers['Content-Type'] = 'application/json';
      await axios.post(url, { parts }, { headers });
    }
  }
}
