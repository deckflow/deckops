import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeFile, type ProbeCallOptions, type ProbeResult } from '@deckflow/deckprobe';
import type { ResolvedInput } from './input.js';

export interface NodeDocumentInspector {
  inspect(
    input: Extract<ResolvedInput, { kind: 'document' | 'stdin' }>,
    options: ProbeCallOptions,
    signal?: AbortSignal
  ): Promise<ProbeResult>;
}

/** Default Node adapter. The dependency initializes its WASM engine lazily. */
export function createNodeDocumentInspector(): NodeDocumentInspector {
  return {
    inspect: async (input, options, signal) => {
      const runtime = { deadlineMs: 2500, maxInputBytes: 16 * 1024 * 1024, ...(signal ? { signal } : {}) };
      if (input.kind === 'document') {
        return probeFile(input.file, options, runtime);
      }
      if (input.data.byteLength > runtime.maxInputBytes) return { schema_version: 2, tool_version: '2.6.0', status: 'error', error: { code: 'BUDGET_EXCEEDED', message: 'stdin exceeds preflight input limit', exit_code: 4 } };
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'deckops-probe-'));
      try {
        const file = path.join(temp, path.basename(input.name));
        await fs.writeFile(file, input.data);
        return await probeFile(file, { ...options, sourceKind: 'stdin' }, runtime);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    },
  };
}
