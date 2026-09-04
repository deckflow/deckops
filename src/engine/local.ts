import fs from 'node:fs/promises';
import { DeckParseError } from '../errors/index.js';
import { sha256 } from '../ir/ids.js';
import type { ParseCandidate } from '../ir/schema.js';
import { type SourceIdentity } from '../local/common.js';
import { fetchHtml } from '../local/html/parser.js';
import { resolveLimits } from '../local/limits.js';
import { parsePdf } from '../local/pdf/adapter.js';
import { runLocalWorker } from '../local/runner.js';
import type { EngineParseInput, EngineParseOptions, ParseEngine, SupportDecision } from './types.js';

export class LocalEngine implements ParseEngine {
  readonly id = 'local' as const;

  supports(input: EngineParseInput, options: EngineParseOptions): SupportDecision {
    if (input.input.kind === 'link') {
      return options.flags.mode === 'runtime'
        ? { supported: false, reason: 'runtime_required', hint: 'Use --engine cloud for runtime URL parsing.' }
        : { supported: true };
    }
    if (input.input.taskType === 'keynote.parseTextAndImage') {
      return { supported: false, reason: 'unsupported_local', hint: 'Keynote IWA parsing is cloud-only. Use --engine cloud.' };
    }
    if (input.input.taskType === 'pdf.pdfParse' && options.flags.profile && options.flags.profile !== 'balanced') {
      return { supported: false, reason: 'profile_cloud_only', hint: 'The local pdf-lite-parse API uses its balanced profile. Use --profile balanced or --engine cloud.' };
    }
    return { supported: true };
  }

  async parse(input: EngineParseInput, options: EngineParseOptions, signal: AbortSignal): Promise<ParseCandidate> {
    const support = this.supports(input, options);
    if (!support.supported) throw DeckParseError.unsupported(support.reason ?? 'Input is not supported locally.', support.hint ? { hint: support.hint } : {});
    try {
      const limits = resolveLimits(options.common.limits);
      if (input.input.kind === 'link') {
        const fetched = await fetchHtml(input.input.url, limits, signal);
        const identity: SourceIdentity = { sha256: sha256(fetched.bytes), name: fetched.url, bytes: fetched.bytes.byteLength };
        return await runLocalWorker({ kind: 'html', html: fetched.html, source: identity, baseUrl: fetched.url, limits }, signal);
      }
      const identity = input.source ?? await sourceIdentity(input.input);
      if (identity.bytes > limits.sourceBytes) throw DeckParseError.input('Source exceeds the local input size limit.');
      if (input.input.taskType === 'pdf.pdfParse') {
        const source = input.input.kind === 'document' ? input.input.file : input.input.data;
        return await parsePdf(source, identity, limits, {
          ...(options.flags.password !== undefined ? { password: options.flags.password } : {}),
          ...(options.flags.pageFurniture !== undefined ? { pageFurniture: options.flags.pageFurniture } : {}),
          ...(options.flags.overlaidText !== undefined ? { overlaidText: options.flags.overlaidText } : {}),
          ...(options.flags.includeImages !== undefined ? { includeImages: options.flags.includeImages } : {}),
        });
      }
      const bytes = input.input.kind === 'document' ? new Uint8Array(await fs.readFile(input.input.file)) : input.input.data;
      if (input.input.taskType === 'docx.parseTextAndImage') return await runLocalWorker({ kind: 'docx', data: bytes, source: identity, limits, options: { ...(options.flags.trackedChanges ? { trackedChanges: options.flags.trackedChanges } : {}) } }, signal);
      if (input.input.taskType === 'pptx.parse') return await runLocalWorker({ kind: 'pptx', data: bytes, source: identity, limits }, signal);
      throw DeckParseError.unsupported('This format has no local parser.');
    } catch (error) {
      if (error instanceof DeckParseError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw DeckParseError.input(`Local parsing failed: ${message}`, { hint: 'Inspect the quality/format, or explicitly retry with --engine cloud.', cause: error });
    }
  }
}

async function sourceIdentity(input: Exclude<EngineParseInput['input'], { kind: 'link' }>): Promise<SourceIdentity> {
  const bytes = input.kind === 'document' ? new Uint8Array(await fs.readFile(input.file)) : input.data;
  return { sha256: sha256(bytes), name: input.name, bytes: bytes.byteLength };
}
