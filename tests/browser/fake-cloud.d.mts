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
}
export interface FakeCloud {
  origin: string;
  apiBase(name?: string): string;
  state(name: string): FakeState;
  close(): Promise<void>;
}
export function createFakeCloud(options?: { staticRoot?: string; port?: number }): Promise<FakeCloud>;
