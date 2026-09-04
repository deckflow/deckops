import { probe, probeFile, type ProbeCallOptions, type ProbeResult } from '@deckflow/deckprobe';
import type { ResolvedInput } from './input.js';

export interface NodeDocumentInspector {
  inspect(
    input: Extract<ResolvedInput, { kind: 'document' | 'stdin' }>,
    options: ProbeCallOptions
  ): Promise<ProbeResult>;
}

/** Default Node adapter. The dependency initializes its WASM engine lazily. */
export function createNodeDocumentInspector(): NodeDocumentInspector {
  return {
    inspect: async (input, options) => {
      if (input.kind === 'document') {
        return probeFile(input.file, options);
      }
      return probe(input.data, { ...options, name: input.name, sourceKind: 'stdin' });
    },
  };
}
