import type { ParseCandidate } from '../ir/schema.js';
import type { SourceIdentity } from './common.js';
import type { DocxOptions } from './docx/parser.js';
import type { LocalLimits } from './limits.js';

export type WorkerRequest =
  | { kind: 'docx'; data: Uint8Array; source: SourceIdentity; limits: LocalLimits; options: DocxOptions }
  | { kind: 'pptx'; data: Uint8Array; source: SourceIdentity; limits: LocalLimits }
  | { kind: 'html'; html: string; source: SourceIdentity; baseUrl?: string | undefined; limits: LocalLimits };

export type WorkerResponse =
  | { ok: true; candidate: ParseCandidate }
  | { ok: false; error: { name: string; message: string; code?: string | undefined; hint?: string | undefined; stack?: string | undefined } };
