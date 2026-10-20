export interface RequestRecord {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown> | string;
  bytes: number;
  closed?: boolean;
}
export interface FakeState {
  requests: RequestRecord[];
  tasks: Array<{ id: string; spaceId: string; type: string; status: string; params: Record<string, unknown>; fileIds: string[] }>;
  uploads: Array<{ id: string; name: string; bytes: number; hash: string }>;
  activeStreams: number;
  closedStreams: number;
  abortedCreates: number;
  /** Fail this many result downloads with 503 (set by a test). */
  failDownloads?: number;
  /** File ids the server has forgotten: tasks naming them get 404 (set by a test). */
  expiredFiles?: string[];
  /** Frames a multi-frame render returns (default 3; set by a test). */
  frames?: number;
}
export interface FakeCloud {
  origin: string;
  apiBase(name?: string): string;
  state(name: string): FakeState;
  close(): Promise<void>;
}
export const FIXTURE_PNG: Buffer;
export const FIXTURE_MARKDOWN: string;
export const FIXTURE_MARKDOWN_PAGES: string[];
export const FIXTURE_DOCUMENT: Record<string, unknown>;
export const FIXTURE_CAPABILITIES: { tasks: Record<string, { to: string[] }> } & Record<string, unknown>;
export function createFakeCloud(options?: { staticRoot?: string; port?: number }): Promise<FakeCloud>;
