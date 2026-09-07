import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArtifacts } from 'pdf-lite-parse';
import { parsePdf } from '../../src/local/pdf/adapter.js';
import { DEFAULT_LOCAL_LIMITS } from '../../src/local/limits.js';

vi.mock('pdf-lite-parse', () => ({ parseArtifacts: vi.fn() }));
const source = { sha256: 'a'.repeat(64), name: 'fixture.pdf', bytes: 1 };

beforeEach(() => {
  vi.mocked(parseArtifacts).mockReset().mockResolvedValue({
    document: { elements: [], pages: [], warnings: [], source: { encrypted: false }, docInfo: {}, outline: null },
    metadata: { parserVersion: '0.2.7' }, assets: new Map(),
  } as never);
});

describe('lightweight PDF adapter', () => {
  it('explicitly requests embedded images and records the actual parser version', async () => {
    const result = await parsePdf('fixture.pdf', source, DEFAULT_LOCAL_LIMITS);
    expect(parseArtifacts).toHaveBeenCalledWith('fixture.pdf', { images: 'embedded' });
    expect(result.ir.producer).toEqual({ engine: 'local', name: 'pdf-lite-parse', version: '0.2.7' });
  });

  it('disables upstream image work while forwarding text and password options', async () => {
    const result = await parsePdf('fixture.pdf', source, DEFAULT_LOCAL_LIMITS, {
      includeImages: false, overlaidText: 'keep', pageFurniture: 'extract', password: 'test-password',
    });
    expect(parseArtifacts).toHaveBeenCalledWith('fixture.pdf', {
      images: 'none', overlaidText: 'keep', pageFurniture: 'extract', password: 'test-password',
    });
    expect(result.assets).toEqual([]);
    expect(result.ir.document.assets).toEqual([]);
  });
});
