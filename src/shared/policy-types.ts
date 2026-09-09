export interface ExecutionPolicy {
  version: 1; engine: 'local' | 'auto' | 'cloud'; upload: 'deny' | 'allow'; acceptance: 'best-effort' | 'no-degraded';
  maxParseSubmissions: 1; source: Record<string, string>;
}
export interface RouteDecision {
  action: 'keep_local' | 'upgrade' | 'use_cloud'; reason: string; policy: ExecutionPolicy;
  alternatives: Array<{ engine: 'cloud'; capability: string; verification: string; uploadScope: 'entire_document'; requires: string[] }>;
  attempts: Array<{ engine: 'cloud'; status: string; taskId?: string }>;
  next?: { argv: string[]; message?: string };
}
