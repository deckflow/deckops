/**
 * Task status types
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Task object returned from API
 */
export interface Task {
  id: string;
  type: string;
  status: TaskStatus;
  spaceId: string;
  fileIds?: string[];
  name?: string;
  params?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
}

/**
 * Task list response with pagination
 */
export interface TaskListResponse {
  tasks: Task[];
  total?: number;
}

/**
 * Upload platform types
 */
export type UploadPlatform = 'oss' | 'local';

/**
 * Authorization info for upload
 */
export interface AuthInfo {
  url: string;
  headers: Record<string, string>;
  Authorization?: string;
}

/**
 * Part authorization for multipart upload
 */
export interface PartAuth {
  url: string;
  headers: Record<string, string>;
  Authorization?: string;
}

/**
 * Upload authorization response
 */
export interface UploadAuthResponse {
  id: string;
  key: string;
  hash: string;
  platform: UploadPlatform;
  multipart: boolean;
  auth?: AuthInfo;
  multipartUploadId?: string;
  multipartPartSize?: number;
  multipartPartAuths?: PartAuth[];
}

/**
 * Part result after upload
 */
export interface PartResult {
  partNumber: number;
  eTag?: string;
  hash?: string;
}

/**
 * File digest information
 */
export interface FileDigest {
  name: string;
  bytes: number;
  hash: string;
  chunkSize: number;
}
