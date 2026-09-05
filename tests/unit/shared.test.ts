import { describe, expect, it } from 'vitest';
import { validateConvertFlags, validateParseFlags } from '../../src/core/validation.js';
import { DeckOpsError } from '../../src/errors/index.js';
import { PRE_UPLOAD_THRESHOLD } from '../../src/shared/constants.js';
import { translateError } from '../../src/shared/errors.js';
import { EXTENSION_ROUTES, extensionOf, routeExtension, SUPPORTED_EXTENSIONS } from '../../src/shared/input.js';
import { convertParams, parseParams } from '../../src/shared/params.js';
import {
  formatForTaskType,
  validateConvertFlagsForFormat,
  validateParseFlagsForFormat,
} from '../../src/shared/validation.js';
import type { ResolvedInput } from '../../src/core/input.js';
import { preflightModeForConvert, preflightModeOf } from '../../src/cli/commands/run-ops.js';

describe('shared preflight default', () => {
  it('defaults CLI operations to validate while preserving explicit off and strict', () => {
    expect(preflightModeOf({})).toBe('validate');
    expect(preflightModeOf({ preflight: 'off' })).toBe('off');
    expect(preflightModeOf({ preflight: 'strict' })).toBe('strict');
  });

  it('does not apply the implicit source default to an existing artifact', () => {
    const artifact: ResolvedInput = {
      kind: 'artifact',
      dir: 'example',
      manifest: {
        manifestVersion: 1,
        source: { name: 'slides.pptx' },
        parse: { type: 'pptx.parse', taskId: 'parse-task', irKey: 'ir-key', irSchemaVersion: 'pptx.v1', params: {}, createdAt: '2026-01-01' },
        views: {}, assets: {}, producer: { deckparse: 'test', sdk: 'test' },
      },
    };
    expect(preflightModeForConvert(artifact, {})).toBeUndefined();
    expect(preflightModeForConvert(artifact, { preflight: 'validate' })).toBe('validate');
  });
});

describe('shared input routing', () => {
  it('routes the supported formats without requiring a filesystem input', () => {
    expect(SUPPORTED_EXTENSIONS).toEqual(['.pdf', '.pptx', '.docx', '.key']);
    expect(routeExtension('C:\\slides\\DECK.PPTX?download=true')).toBe(EXTENSION_ROUTES['.pptx']);
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('https://example.com/a.DOCX#page')).toBe('.docx');
    expect(() => routeExtension('unnamed')).toThrow('Cannot tell the format');
  });

  it('shares the exact 4 MiB pre-upload boundary', () => {
    expect(PRE_UPLOAD_THRESHOLD).toBe(4_194_304);
  });
});

describe('shared backend parameter mapping', () => {
  it('maps only defined parse flags and retains falsy values', () => {
    expect(parseParams({}, false)).toEqual({});
    expect(parseParams({ profile: 'quality', password: '', includeImages: false, stayImageAreaRate: 0 }, false))
      .toEqual({ parseProfile: 'quality', password: '', includeImages: false, stayImageAreaRate: 0 });
    expect(parseParams({ mode: 'runtime' }, false)).toEqual({});
    expect(parseParams({ mode: 'runtime' }, true)).toEqual({ mode: 'runtime' });
  });

  it('maps conversion flags without leaking local storage or output options', () => {
    expect(convertParams({})).toEqual({});
    expect(convertParams({ to: 'markdown', anchors: false, splitPages: true, strict: false, keepRemoteImages: true }))
      .toEqual({ markdownMeta: false, markdownPages: true, markdownStrict: false });
  });
});

describe('shared format validation', () => {
  it('maps cloud task types without inferring unknown ones', () => {
    expect(formatForTaskType('pdf.pdfParse')).toBe('pdf');
    expect(formatForTaskType('pptx.parse')).toBe('pptx');
    expect(formatForTaskType('docx.parseTextAndImage')).toBe('docx');
    expect(formatForTaskType('keynote.parseTextAndImage')).toBe('keynote');
    expect(formatForTaskType('html.getByURL')).toBe('link');
    expect(formatForTaskType('unknown.parse')).toBeUndefined();
  });

  it('accepts applicable parse flags and rejects even explicitly disabled inapplicable parse flags', () => {
    expect(() => validateParseFlagsForFormat('pdf', { profile: 'fast', password: '', includeImages: false })).not.toThrow();
    expect(() => validateParseFlagsForFormat('keynote', { stayImageAreaRate: 0 })).not.toThrow();
    expect(() => validateParseFlagsForFormat('link', { mode: 'source' })).not.toThrow();
    expect(() => validateParseFlagsForFormat('pptx', { includeImages: false }))
      .toThrow('--include-images only applies to pdf input, not pptx.');
    expect(() => validateParseFlagsForFormat('docx', { mode: 'runtime' }))
      .toThrow('--mode only applies to link input, not docx.');
  });

  it('preserves the Node behavior of ignoring explicitly disabled conversion flags', () => {
    expect(() => validateConvertFlagsForFormat('pdf', { anchors: true })).not.toThrow();
    expect(() => validateConvertFlagsForFormat('pptx', { splitPages: true })).not.toThrow();
    expect(() => validateConvertFlagsForFormat('keynote', { splitPages: true })).not.toThrow();
    expect(() => validateConvertFlagsForFormat('docx', { anchors: false, splitPages: false, strict: true })).not.toThrow();
    expect(() => validateConvertFlagsForFormat('pdf', { splitPages: true }))
      .toThrow('--split-pages only applies to pptx/keynote input, not pdf.');
    expect(() => validateConvertFlagsForFormat('link', { anchors: true }))
      .toThrow('--anchors only applies to pdf input, not link.');
  });

  it('keeps artifact-specific rejection in the Node validation wrapper', () => {
    const artifact: ResolvedInput = {
      kind: 'artifact',
      dir: 'example',
      manifest: {
        manifestVersion: 1,
        source: { name: 'slides.pptx' },
        parse: { type: 'pptx.parse', taskId: 'parse-task', irKey: 'ir-key', irSchemaVersion: 'pptx.v1', params: {}, createdAt: '2026-01-01' },
        views: {},
        assets: {},
        producer: { deckparse: 'test', sdk: 'test' },
      },
    };
    expect(() => validateParseFlags(artifact, {})).not.toThrow();
    expect(() => validateParseFlags(artifact, { includeImages: false }))
      .toThrow('Parse flags (--include-images) cannot apply to an artifact — it is already parsed.');
    expect(() => validateConvertFlags(artifact, { splitPages: true })).not.toThrow();
    expect(() => validateConvertFlags(artifact, { anchors: true }))
      .toThrow('--anchors only applies to pdf input, not pptx.');
  });
});

/** The shared translator must not need the Node SDK's APIError constructor. */
const apiError = (statusCode: number | undefined, code?: string): Error => Object.assign(new Error('backend failure'), {
  name: 'APIError',
  statusCode,
  ...(code === undefined ? {} : { responseData: { code } }),
});

describe('shared error translation', () => {
  it('preserves body-code mapping when the SDK error has no HTTP status', () => {
    const cases = [
      ['irExpired', 'ir_expired'],
      ['irNotFound', 'ir_not_found'],
      ['irSchemaUnsupported', 'ir_schema_unsupported'],
      ['irInvalid', 'ir_invalid'],
      ['guestTaskOverLimit', 'quota_error'],
    ] as const;
    for (const [bodyCode, code] of cases) {
      const original = apiError(undefined, bodyCode);
      expect(translateError(original)).toMatchObject({ code, cause: original });
      expect(translateError(original, 'browser')).toMatchObject({ code, cause: original });
    }
    expect(translateError(apiError(undefined)).code).toBe('backend_error');
  });

  it('recognizes SDK API errors structurally and keeps task metadata', () => {
    const original = apiError(422, 'irExpired');
    const translated = translateError(original, 'browser', 'task-123');
    expect(translated).toMatchObject({ code: 'ir_expired', message: 'backend failure', taskId: 'task-123', cause: original });
    expect(translateError(apiError(401), 'browser').code).toBe('auth_error');
    expect(translateError(apiError(410), 'browser').code).toBe('ir_expired');
    expect(translateError(apiError(429), 'browser').code).toBe('quota_error');
    expect(translateError(apiError(500), 'browser').code).toBe('backend_error');
  });

  it('preserves the Node hints and gives browser callers actionable non-CLI hints', () => {
    expect(translateError(apiError(401)).hint)
      .toBe('Run `deckops auth login`, or check `deckops config list` for a stale credential.');
    expect(translateError(apiError(404)).hint).toContain('`deckops config list`');
    expect(translateError(new Error('Task did not complete within 60 seconds')).hint)
      .toBe('Raise --timeout, or check the task later with its taskId.');
    for (const error of [apiError(401), apiError(404), apiError(410), apiError(429), apiError(422, 'irNotFound'), new Error('Task did not complete within 60 seconds')]) {
      const translated = translateError(error, 'browser');
      expect(translated.hint).toBeTruthy();
      expect(translated.hint).not.toMatch(/deckops|--timeout/);
    }
  });

  it('preserves DeckOpsError identity and handles ordinary errors and unknown values', () => {
    const known = DeckOpsError.input('Missing input', { taskId: 'existing-task' });
    expect(translateError(known, 'browser', 'other-task')).toBe(known);
    expect(translateError(new Error('oops'), 'browser', 'task-id')).toMatchObject({ code: 'backend_error', taskId: 'task-id' });
    expect(translateError('oops', 'browser', 'task-id')).toMatchObject({ code: 'backend_error', message: 'oops', taskId: 'task-id' });
    expect(translateError(new Error('pptx.parse returned no irKey.'), 'browser').hint).toContain('0.22.0');
  });
});
