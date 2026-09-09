import type { Evidence, ProbeReport, ProbeResult } from '@deckflow/deckprobe';
import { describe, expect, it } from 'vitest';
import { assessPreflight, preflightProbeOptions, summarize } from '../../src/shared/preflight.js';

const evidence = (target: string, value: unknown, confidence: Evidence['confidence'] = 'exact'): Evidence => ({
  target,
  status: 'resolved',
  value,
  confidence,
  confidence_score: confidence === 'exact' ? 1 : 0.95,
  path: 'fixture.path',
  source: 'fixture',
});

const report = (overrides: Partial<ProbeReport> = {}): ProbeReport => ({
  schema_version: 2,
  tool_version: '2.4.0',
  status: 'ok',
  input: { display_name: 'deck.pptx', source_kind: 'browser_bytes', file_size: 100 },
  driver: { id: 'powerpoint', profile: 'pptx' },
  results: {
    'document.format_profile': evidence('document.format_profile', 'pptx'),
    'document.extension_matches': evidence('document.extension_matches', true),
    'security.encrypted': evidence('security.encrypted', false),
    'security.has_macros': evidence('security.has_macros', false),
    'security.has_external_relationships': evidence('security.has_external_relationships', false),
    'security.has_embedded_files': evidence('security.has_embedded_files', false),
    'powerpoint.slide_count': evidence('powerpoint.slide_count', 12, 'high'),
    'powerpoint.slide_size': evidence('powerpoint.slide_size', { width_pt: 960, height_pt: 540 }),
  },
  execution: {
    probe_level: 'metadata', paths: ['fixture.path'], estimated_cost: 1,
    actual_cost: { physical_bytes_read: 10, expanded_bytes: 5, random_reads: 1 }, unresolved_targets: [],
  },
  diagnostics: [],
  ...overrides,
});

describe('preflight request', () => {
  it('uses explicit bounded metadata targets instead of broad presets', () => {
    const options = preflightProbeOptions('pptx');
    expect(options.level).toBe('metadata');
    expect(options.targets).toContain('document.extension_matches');
    expect(options.targets).toContain('powerpoint.slide_size');
    expect(options.targets?.some((target) => target.startsWith('@'))).toBe(false);
    expect(options.budget).toEqual({
      maxPhysicalBytes: 16 * 1024 * 1024,
      maxExpandedBytes: 8 * 1024 * 1024,
      maxArchiveEntries: 10_000,
      timeoutMs: 1_000,
    });
  });

  it('does not request unsupported OOXML security targets from Keynote', () => {
    const targets = preflightProbeOptions('keynote').targets;
    expect(targets).toContain('security.has_macros');
    expect(targets).toContain('keynote.slide_count');
    expect(targets).not.toContain('security.has_external_relationships');
    expect(targets).not.toContain('security.has_embedded_files');
  });
});

describe('target-level policy', () => {
  it('returns routing facts and converts active-content signals into warnings', () => {
    const input = report();
    input.results['security.has_macros'] = evidence('security.has_macros', true);
    input.results['security.has_external_relationships'] = evidence('security.has_external_relationships', true);
    const outcome = assessPreflight(input, { mode: 'validate', format: 'pptx', passwordProvided: false });
    expect(outcome.summary).toMatchObject({ profile: 'pptx', slideCount: 12, hasMacros: true });
    expect(outcome.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('macros'), expect.stringContaining('external relationships'),
    ]));
    expect(summarize(input).slideSize).toEqual({ width_pt: 960, height_pt: 540 });
  });

  it('does not reject a partial report unless a required fact is unresolved in strict mode', () => {
    const input = report({ status: 'partial' });
    input.results['security.encrypted'] = {
      target: 'security.encrypted', status: 'unknown', confidence: 'none', confidence_score: 0,
      path: 'fixture.path', source: 'none',
    };
    expect(assessPreflight(input, { mode: 'validate', format: 'pptx', passwordProvided: false }).warnings[0])
      .toContain('security.encrypted');
    expect(() => assessPreflight(input, { mode: 'strict', format: 'pptx', passwordProvided: false }))
      .toThrow('required preflight facts');
  });

  it('rejects format mismatches and encryption without an applicable password', () => {
    expect(() => assessPreflight(report({ driver: { id: 'word', profile: 'docx' } }), {
      mode: 'validate', format: 'pptx', passwordProvided: false,
    })).toThrow('file content is docx');

    const encrypted = report({ driver: { id: 'pdf', profile: 'pdf' } });
    encrypted.results['document.format_profile'] = evidence('document.format_profile', 'pdf');
    encrypted.results['security.encrypted'] = evidence('security.encrypted', true);
    expect(() => assessPreflight(encrypted, { mode: 'validate', format: 'pdf', passwordProvided: false }))
      .toThrow('encrypted');
    expect(assessPreflight(encrypted, { mode: 'validate', format: 'pdf', passwordProvided: true }).warnings[0])
      .toContain('provided password');
  });

  it('always rejects malformed input, but only strict mode rejects a probe budget failure', () => {
    const failure = (code: string): ProbeResult => ({
      schema_version: 2, tool_version: '2.4.0', status: 'error',
      error: { code, message: 'fixture failure', exit_code: 4 },
    });
    expect(() => assessPreflight(failure('MALFORMED_INPUT'), {
      mode: 'validate', format: 'pptx', passwordProvided: false,
    })).toThrow('rejected the document container');
    expect(assessPreflight(failure('BUDGET_EXCEEDED'), {
      mode: 'validate', format: 'pptx', passwordProvided: false,
    }).warnings[0]).toContain('Parsing will continue with preflight uncertainty');
    expect(() => assessPreflight(failure('BUDGET_EXCEEDED'), {
      mode: 'strict', format: 'pptx', passwordProvided: false,
    })).toThrow('did not complete');
  });
});
