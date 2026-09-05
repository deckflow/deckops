import type {
  Evidence,
  ProbeCallOptions,
  ProbeReport,
  ProbeResult,
} from '@deckflow/deckprobe';
import { DeckOpsError } from '../errors/index.js';

export type PreflightMode = 'off' | 'validate' | 'strict';

/** Safe-by-default: definite input failures block upload; probe runtime failures only warn. */
export const DEFAULT_PREFLIGHT_MODE: PreflightMode = 'validate';

export type PreflightFormat = 'pdf' | 'pptx' | 'docx' | 'keynote';

export type DeckProbeReport = ProbeReport;
export type DeckProbeResult = ProbeResult;

export interface PreflightSummary {
  profile: string;
  encrypted?: boolean;
  hasMacros?: boolean;
  hasExternalRelationships?: boolean;
  hasEmbeddedFiles?: boolean;
  pageCount?: number;
  slideCount?: number;
  slideSize?: Record<string, unknown>;
}

export interface PreflightOutcome {
  report?: DeckProbeReport;
  summary?: PreflightSummary;
  warnings: string[];
}

export interface AssessPreflightOptions {
  mode: Exclude<PreflightMode, 'off'>;
  format: PreflightFormat;
  passwordProvided: boolean;
}

export const PREFLIGHT_REQUEST_VERSION = 1;

const REQUIRED_TARGETS = [
  'document.format_profile',
  'document.extension_matches',
  'security.encrypted',
] as const;

const SECURITY_FACT_TARGETS: Record<PreflightFormat, readonly string[]> = {
  pdf: ['security.has_macros', 'security.has_external_relationships', 'security.has_embedded_files'],
  pptx: ['security.has_macros', 'security.has_external_relationships', 'security.has_embedded_files'],
  docx: ['security.has_macros', 'security.has_external_relationships', 'security.has_embedded_files'],
  // Modern iWork can resolve macro capability, but has no OOXML relationship or embedded-file targets.
  keynote: ['security.has_macros'],
};

const FORMAT_FACT_TARGETS: Record<PreflightFormat, readonly string[]> = {
  pdf: ['pdf.page_count'],
  pptx: ['powerpoint.slide_count', 'powerpoint.slide_size'],
  docx: ['word.page_count'],
  keynote: ['keynote.slide_count'],
};

const EXPECTED_PROFILE: Record<PreflightFormat, string> = {
  pdf: 'pdf',
  pptx: 'pptx',
  docx: 'docx',
  keynote: 'key',
};

/**
 * A stable, explicit probe request. Do not replace this with @summary: missing
 * optional metadata such as a title would turn a healthy file into `partial`.
 */
export function preflightProbeOptions(format: PreflightFormat): ProbeCallOptions {
  return {
    level: 'metadata',
    minimumConfidence: 'high',
    targets: [...REQUIRED_TARGETS, ...SECURITY_FACT_TARGETS[format], ...FORMAT_FACT_TARGETS[format]],
    allowPiggyback: true,
    telemetry: false,
    budget: {
      maxPhysicalBytes: 16 * 1024 * 1024,
      maxExpandedBytes: 8 * 1024 * 1024,
      maxArchiveEntries: 10_000,
      timeoutMs: 1_000,
    },
  };
}

export function assessPreflight(result: DeckProbeResult, options: AssessPreflightOptions): PreflightOutcome {
  if (result.status === 'error') {
    return assessProbeError(result, options.mode);
  }

  const expected = EXPECTED_PROFILE[options.format];
  if (result.driver.profile !== expected) {
    throw DeckOpsError.input(
      `The file content is ${result.driver.profile}, but its name selects ${expected}.`,
      { hint: 'Use the correct filename extension and try again.' }
    );
  }

  const extensionMatches = valueOf(result, 'document.extension_matches');
  if (extensionMatches === false) {
    throw DeckOpsError.input('The filename extension does not match the document content.', {
      hint: 'Use the correct filename extension and try again.',
    });
  }

  const warnings: string[] = [];
  const unresolved = REQUIRED_TARGETS.filter((target) => !usable(result.results[target]));
  if (unresolved.length > 0) {
    const message = `DeckProbe could not resolve required preflight facts: ${unresolved.join(', ')}.`;
    if (options.mode === 'strict') {
      throw DeckOpsError.input(message, { hint: 'Retry with preflight validate/off, or inspect the file with DeckProbe.' });
    }
    warnings.push(`${message} Cloud parsing will continue.`);
  }

  const encrypted = booleanValue(result, 'security.encrypted');
  if (encrypted === true) {
    if (options.format === 'pdf' && options.passwordProvided) {
      warnings.push('DeckProbe found an encrypted PDF; continuing with the provided password.');
    } else {
      throw DeckOpsError.input('The document is encrypted or password-protected.', {
        hint: options.format === 'pdf'
          ? 'Provide the PDF password, or save an unencrypted copy.'
          : 'Save an unencrypted copy before parsing.',
      });
    }
  }

  warnIfTrue(result, 'security.has_macros', 'DeckProbe found macros or macro-capable content.', warnings);
  warnIfTrue(result, 'security.has_external_relationships', 'DeckProbe found external relationships.', warnings);
  warnIfTrue(result, 'security.has_embedded_files', 'DeckProbe found embedded files or objects.', warnings);

  return { report: result, summary: summarize(result), warnings };
}

export function summarize(report: DeckProbeReport): PreflightSummary {
  const encrypted = booleanValue(report, 'security.encrypted');
  const hasMacros = booleanValue(report, 'security.has_macros');
  const hasExternalRelationships = booleanValue(report, 'security.has_external_relationships');
  const hasEmbeddedFiles = booleanValue(report, 'security.has_embedded_files');
  const pageCount = numberValue(report, report.driver.profile === 'pdf' ? 'pdf.page_count' : 'word.page_count');
  const slideCount = numberValue(report, report.driver.profile === 'key' ? 'keynote.slide_count' : 'powerpoint.slide_count');
  const slideSize = objectValue(report, 'powerpoint.slide_size');
  return {
    profile: report.driver.profile,
    ...(encrypted !== undefined ? { encrypted } : {}),
    ...(hasMacros !== undefined ? { hasMacros } : {}),
    ...(hasExternalRelationships !== undefined ? { hasExternalRelationships } : {}),
    ...(hasEmbeddedFiles !== undefined ? { hasEmbeddedFiles } : {}),
    ...(pageCount !== undefined ? { pageCount } : {}),
    ...(slideCount !== undefined ? { slideCount } : {}),
    ...(slideSize !== undefined ? { slideSize } : {}),
  };
}

function assessProbeError(
  result: Extract<DeckProbeResult, { status: 'error' }>,
  mode: Exclude<PreflightMode, 'off'>
): PreflightOutcome {
  const { code, message } = result.error;
  switch (code) {
    case 'MALFORMED_INPUT':
      throw DeckOpsError.input(`DeckProbe rejected the document container: ${message}`, {
        hint: 'Check that the file is complete and its extension matches its content.',
      });
    case 'UNSUPPORTED_FORMAT':
      throw DeckOpsError.unsupported(`DeckProbe cannot inspect this document generation: ${message}`);
    case 'SOURCE_IO':
      throw DeckOpsError.input(`DeckProbe could not read the input: ${message}`);
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_TARGET':
      throw DeckOpsError.backend(`DeckOps sent an invalid DeckProbe request: ${message}`);
    default: {
      const explanation = `DeckProbe preflight did not complete (${code}): ${message}`;
      if (mode === 'strict') {
        throw DeckOpsError.input(explanation, {
          hint: 'Retry with preflight validate/off, or inspect the file with DeckProbe.',
        });
      }
      return { warnings: [`${explanation}. Cloud parsing will continue.`] };
    }
  }
}

function usable(evidence: Evidence | undefined): boolean {
  return evidence !== undefined &&
    (evidence.status === 'resolved' || evidence.status === 'estimated') &&
    ['high', 'exact'].includes(evidence.confidence);
}

function valueOf(report: DeckProbeReport, target: string): unknown {
  const evidence = report.results[target];
  return usable(evidence) ? evidence?.value : undefined;
}

function booleanValue(report: DeckProbeReport, target: string): boolean | undefined {
  const value = valueOf(report, target);
  return typeof value === 'boolean' ? value : undefined;
}

function numberValue(report: DeckProbeReport, target: string): number | undefined {
  const value = valueOf(report, target);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectValue(report: DeckProbeReport, target: string): Record<string, unknown> | undefined {
  const value = valueOf(report, target);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function warnIfTrue(report: DeckProbeReport, target: string, message: string, warnings: string[]): void {
  if (booleanValue(report, target) === true) warnings.push(message);
}
