import { describe, expect, it, vi, afterEach } from 'vitest';
import { evaluatePolicy } from '../../src/engine/policy.js';
import { assessCandidate } from '../../src/quality/assessment.js';
import { routeParse } from '../../src/engine/router.js';
import { LocalEngine } from '../../src/engine/local.js';
import { CloudEngine } from '../../src/engine/cloud.js';
import { result3ToDeckIr } from '../../src/ir/result3-adapter.js';
import type { ParseCandidate } from '../../src/ir/schema.js';
const source = { sha256: 'a'.repeat(64), name: 'a.pdf', bytes: 100 };
const input = { input: { kind: 'document' as const, file: 'a.pdf', name: 'a.pdf', taskType: 'pdf.pdfParse' as const }, inputLabel: 'a.pdf', source };
function candidate(engine: 'local' | 'cloud', failure = false): ParseCandidate {
  const checks = failure ? [{ code: 'page_parse_failed', severity: 'error' as const, pages: [1], message: 'Page failed' }] : [];
  const quality = { status: failure ? 'degraded' as const : 'pass' as const, checks, coverage: { sourceObjectCoverage: 1, pages: { total: 1, parsed: failure ? 0 : 1 } } };
  const ir = { schemaVersion: 'deckir.v1' as const, format: 'pdf' as const, source, producer: { engine, name: engine, version: '1' }, quality,
    document: { metadata: {}, assets: [], pages: [{ id: 'p1', index: 1, nodeIds: ['n1'], sourceRef: { page: 1 } }],
      nodes: [{ id: 'n1', type: 'text', parentId: null, children: [], order: 0, page: 1, text: failure ? '' : 'A recovered page with enough readable words.', sourceRef: { page: 1 } }] } };
  return { ir, quality, assets: [] };
}
afterEach(() => vi.restoreAllMocks());
describe('deterministic upgrade policy', () => {
  it('keeps local for denied upload, visual warnings, and unverified remedies', () => {
    const local = candidate('local', true); const assessment = assessCandidate(local);
    expect(evaluatePolicy(input, {}, { engine: 'auto' }, assessment).reason).toBe('upload_denied');
    expect(evaluatePolicy(input, {}, { engine: 'local', allowUpload: true }, assessment).reason).toBe('local_only');
    local.ir.document.nodes[0]!.text = 'Usable body text';
    local.quality.checks = [{ code: 'group_transform_partial', severity: 'warning', message: 'Visual limitation' }];
    expect(evaluatePolicy(input, {}, { engine: 'auto', allowUpload: true }, assessCandidate(local)).action).toBe('keep_local');
    local.quality.checks = [{ code: 'ocr_required', severity: 'error', message: 'Needs OCR' }];
    expect(evaluatePolicy(input, {}, { engine: 'auto', allowUpload: true }, assessCandidate(local)).reason).toBe('capability_unverified');
  });
  it('requires compatible parameters and verifiable hard budgets', () => {
    const assessment = assessCandidate(candidate('local', true));
    expect(evaluatePolicy(input, { trackedChanges: 'all' }, { engine: 'auto', allowUpload: true }, assessment).reason).toBe('parameter_incompatible');
    expect(evaluatePolicy(input, {}, { engine: 'auto', allowUpload: true, cloudLimits: { maxCost: { amount: '1', currency: 'USD' } } }, assessment).reason).toBe('budget_unverifiable');
    expect(evaluatePolicy(input, {}, { engine: 'auto', allowUpload: true, cloudLimits: { maxSourcePages: 10 } }, assessment).reason).toBe('limit_unverifiable');
  });
  it('repairs before applying failOnDegraded and makes just one cloud call', async () => {
    vi.spyOn(LocalEngine.prototype, 'parse').mockResolvedValue(candidate('local', true));
    const cloud = vi.spyOn(CloudEngine.prototype, 'parse').mockResolvedValue(candidate('cloud'));
    const result = await routeParse({ input, parse: { flags: {}, common: { engine: 'auto', allowUpload: true, failOnDegraded: true } }, cloud: async () => ({} as never), signal: AbortSignal.timeout(1000) });
    expect(result.ir.producer.engine).toBe('cloud'); expect(cloud).toHaveBeenCalledTimes(1);
    expect(result.decision?.reason).toBe('quality_improved');
  });
  it('retains a usable local candidate on cloud failure or inconclusive comparison', async () => {
    vi.spyOn(LocalEngine.prototype, 'parse').mockResolvedValue(candidate('local', true));
    const cloud = vi.spyOn(CloudEngine.prototype, 'parse').mockRejectedValue(new Error('offline'));
    const opts = { input, parse: { flags: {}, common: { engine: 'auto' as const, allowUpload: true } }, cloud: async () => ({} as never), signal: AbortSignal.timeout(1000) };
    expect((await routeParse(opts)).decision?.reason).toBe('upgrade_failed');
    const opaque = candidate('cloud'); delete (opaque.quality.coverage as Record<string, unknown>).sourceObjectCoverage;
    cloud.mockResolvedValue(opaque);
    expect((await routeParse(opts)).decision?.reason).toBe('quality_improved');
    cloud.mockResolvedValue(candidate('cloud', true));
    expect((await routeParse(opts)).decision?.reason).toBe('comparison_inconclusive');
  });
  it('never resolves credentials on a healthy local route and stops explicit cancellation', async () => {
    vi.spyOn(LocalEngine.prototype, 'parse').mockResolvedValue(candidate('local'));
    const factory = vi.fn();
    await routeParse({ input, parse: { flags: {}, common: { engine: 'auto', allowUpload: true } }, cloud: factory, signal: AbortSignal.timeout(1000) });
    expect(factory).not.toHaveBeenCalled();
    await expect(routeParse({ input, parse: { flags: {}, common: {} }, cloud: factory, signal: AbortSignal.abort() })).rejects.toBeDefined();
  });
  it('detects a sparse raster page even when another PDF page has plentiful text', () => {
    const page = (index: number, ratio: number) => ({ index, width: 100, height: 100, status: 'ok', sourceObjectCoverage: 1, probe: { imageAreaRatio: ratio } });
    const document = { elements: [{ id: 'e1', type: 'paragraph', parentId: null, children: [], order: 0, page: 1, text: 'healthy '.repeat(200), sourceObjectIds: [], bbox: [0, 0, 1, 1] }], pages: [page(1, 0), page(2, 1), page(3, 0)], warnings: [], source: { encrypted: false }, docInfo: {}, outline: null };
    const result = result3ToDeckIr({ document: document as never, source, producer: { engine: 'local', name: 'fixture', version: '1' } });
    expect(result.quality.checks.find(c => c.code === 'ocr_required')?.pages).toEqual([2]);
    expect(result.quality.checks.find(c => c.code === 'ocr_required')?.detail?.method).toBe('image-text-heuristic');
  });
});
