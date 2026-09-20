import type { DeckIR, ParseCandidate } from '../ir/schema.js';
import type { DeckProbeReport } from '../shared/preflight.js';
import { candidateAssetOutputPath } from '../ir/assets.js';
import { validateDeckIR } from '../ir/validate.js';
import { bodyTextStats } from '../shared/text-quality.js';
export type { QualityIssue, Assessment } from '../shared/assessment-types.js';
import type { QualityIssue, Assessment } from '../shared/assessment-types.js';
const REMEDIES: Record<string, string> = {
  ocr_required: 'ocr', missing_slide: 'document_parse', page_parse_failed: 'document_parse', source_page_count_mismatch: 'document_parse',
  no_body_text: 'document_parse', garbled_text: 'document_parse', control_characters: 'document_parse',
  chart_partial: 'chart_content', smartart_partial: 'smartart_content', table_ambiguous: 'table_structure',
  source_object_loss: 'document_parse', local_parse_failed: 'document_parse', text_layer_suspect: 'document_parse',
  group_transform_partial: 'visual_layout', composite_figure_unavailable: 'visual_layout', unrepresentable_content: 'visual_layout',
  graphic_frame_partial: 'visual_layout', embedded_object_unsupported: 'embedded_content', media_unsupported: 'embedded_content',
  embedded_object_undetected: 'embedded_content',
};
const VISUAL = new Set(['group_transform_partial', 'composite_figure_unavailable', 'media_unsupported', 'embedded_object_unsupported', 'graphic_frame_partial', 'unrepresentable_content']);
const INFORMATIONAL = new Set(['macro_preserved', 'external_asset']);
const sorted = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);
export function assessCandidate(candidate: ParseCandidate, probe?: DeckProbeReport, knownSourcePages?: number): Assessment {
  validateDeckIR(candidate.ir);
  const ir = candidate.ir;
  const issues: QualityIssue[] = candidate.quality.checks.map(check => ({ ...check,
    impact: INFORMATIONAL.has(check.code) || check.severity === 'info' ? 'informational' : VISUAL.has(check.code) ? 'visual_loss'
      : check.code.includes('asset') || check.code === 'missing_media' ? 'delivery'
      : check.code.includes('partial') || check.code.includes('ambiguous') ? 'structure_loss' : 'content_missing',
    evidenceKind: check.code === 'ocr_required' && check.detail?.method === 'image-text-heuristic' ? 'heuristic' : 'parser',
    ...(REMEDIES[check.code] ? { neededCapability: REMEDIES[check.code] } : {}),
  }));
  const key = ir.format === 'pdf' ? 'pdf.page_count' : ir.format === 'pptx' ? 'powerpoint.slide_count' : undefined;
  const evidence = key ? probe?.results[key] : undefined;
  const exactProbe = evidence?.status === 'resolved' && evidence.confidence === 'exact' && typeof evidence.value === 'number' && Number.isSafeInteger(evidence.value) && evidence.value >= 0 ? evidence.value : undefined;
  const total = knownSourcePages ?? (ir.producer.engine === 'local' && key ? candidate.quality.coverage.pages?.total : undefined);
  const sourcePageCount = exactProbe ?? (typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : undefined);
  const pageIndices = new Set(ir.document.pages.map(p => p.index));
  const failedPages = sorted(issues.filter(i => i.code === 'page_parse_failed').flatMap(i => i.pages ?? []));
  const missing = new Set(issues.filter(i => i.code === 'missing_slide').flatMap(i => i.pages ?? []));
  let missingPageCount = missing.size;
  if (sourcePageCount !== undefined) {
    const present = sorted([...pageIndices].filter(p => p >= 1 && p <= sourcePageCount));
    missingPageCount = sourcePageCount - present.length;
    // Bound the list independently of an untrusted source count. Always return the full count.
    let previous = 0;
    for (const next of [...present, sourcePageCount + 1]) {
      for (let p = previous + 1; p < next && missing.size < 1000; p++) missing.add(p);
      previous = next;
      if (missing.size >= 1000) break;
    }
    if (missingPageCount > 0 || pageIndices.size !== sourcePageCount) issues.push({ code: 'source_page_count_mismatch', severity: 'error',
      message: `Source declares ${sourcePageCount} pages/slides; result contains ${pageIndices.size}, with ${missingPageCount} missing.`, impact: 'content_missing', evidenceKind: exactProbe !== undefined ? 'source_comparison' : 'parser', neededCapability: 'document_parse' });
  }
  const stats = bodyTextStats(ir);
  const searchableTextCharacters = stats.characters;
  if (!searchableTextCharacters) issues.push({ code: 'no_body_text', severity: 'warning', message: 'No searchable body text was extracted. Images or a blank document can also produce this result.' + (ir.producer.engine === 'local' ? ' Local OCR is not provided.' : ''), impact: 'content_missing', evidenceKind: 'source_comparison', neededCapability: issues.some(i => i.code === 'ocr_required') ? 'ocr' : 'document_parse' });
  if (stats.text.length >= 100 && (stats.text.match(/\uFFFD/g)?.length ?? 0) / stats.text.length > 0.05) issues.push({ code: 'garbled_text', severity: 'warning', message: 'Extracted text contains an unusually high replacement-character ratio.', impact: 'content_missing', evidenceKind: 'heuristic', neededCapability: 'document_parse' });
  if (stats.controlCharacters) issues.push({ code: 'control_characters', severity: 'warning', message: `${stats.controlCharacters} unsupported control characters in body text; Markdown replaces them with U+FFFD, without recovering the source text.`, impact: 'content_missing', evidenceKind: 'source_comparison', neededCapability: 'document_parse', detail: { count: stats.controlCharacters, replacement: 'U+FFFD' } });
  const assetPaths = new Set(ir.document.assets.map(a => a.path));
  if (ir.document.nodes.some(n => typeof n.extensions?.assetPath === 'string' && !assetPaths.has(n.extensions.assetPath))) issues.push({ code: 'asset_reference_missing', severity: 'error', message: 'An IR image refers to an unavailable artifact asset.', impact: 'delivery', evidenceKind: 'source_comparison' });
  const unassessed = ['reading_order_correctness', 'semantic_accuracy'];
  if (ir.producer.engine === 'cloud' && !('sourceObjectCoverage' in candidate.quality.coverage)) unassessed.push('cloud_content_coverage');
  if (exactProbe === undefined && key) unassessed.push('source_page_completeness');
  const relevant = issues.filter(i => i.severity !== 'info' && i.impact !== 'informational');
  const reasons = [...new Set(relevant.filter(i => i.impact !== 'delivery').map(i => i.code))];
  return { evaluatorVersion: 'rules.v2', status: relevant.length ? 'needs_attention' : unassessed.includes('cloud_content_coverage') ? 'insufficient_evidence' : 'no_issue_detected', issues, unassessed,
    scope: { pages: sorted(pageIndices), ...(sourcePageCount !== undefined ? { sourcePageCount } : {}) },
    summary: { ...(sourcePageCount !== undefined ? { sourcePages: sourcePageCount, sourcePagesEvidence: exactProbe !== undefined ? 'probe' as const : 'parser' as const } : {}),
      parsedPages: [...pageIndices].filter(p => !failedPages.includes(p) && !missing.has(p)).length,
      missingPages: sorted(missing).slice(0, 1000), missingPageCount, ...(missingPageCount > 1000 ? { missingPagesTruncated: true } : {}), failedPages,
      searchableTextCharacters, textlessPages: sorted([...pageIndices].filter(p => !stats.pages.get(p))),
      ocrSuspectedPages: sorted(issues.filter(i => i.code === 'ocr_required').flatMap(i => i.pages ?? [])),
      visualRiskPages: sorted(issues.filter(i => i.impact === 'visual_loss').flatMap(i => i.pages ?? [])), controlCharacters: stats.controlCharacters },
    ...(ir.producer.engine === 'local' && reasons.length ? { recommendation: { engine: 'cloud' as const, paid: true as const, uploadScope: 'entire_document' as const, reasonCodes: reasons,
      message: 'Consider cloud high-quality parsing (paid; uploads the entire document). This is a recommendation, not an upload. Recovery of content missing from the source is not guaranteed.' } } : {}) };
}

/** 解析器表示或报告嵌入对象的方式；命中任一种就说明它知道这些东西存在。 */
const EMBEDDED_REPORTED = new Set(['embedded_object_unsupported', 'graphic_frame_partial', 'chart_partial', 'smartart_partial', 'media_unsupported']);
const EMBEDDED_TYPES = new Set(['graphic_frame', 'chart', 'diagram', 'graphic', 'opaque']);
/** 只在 OOXML 上判：probe 的嵌入对象事实是按 OOXML 部件数得出的，别的格式没有可比口径。 */
const EMBEDDED_FORMATS = new Set(['pptx', 'docx']);

function exactValue(probe: DeckProbeReport | undefined, target: string): unknown {
  const evidence = probe?.results[target];
  return evidence?.status === 'resolved' && evidence.confidence === 'exact' ? evidence.value : undefined;
}

/**
 * 源里有嵌入对象，产物里却既没表示、也没报告 —— 把这件事显式记成降级。
 *
 * 这类缺失不会自己暴露：解析器没产出节点，也就没有任何 check，产物于是以 `pass` 交付。
 * 实测同一份 99 页文档，本地报 147 条 `embedded_object_unsupported` 而判 degraded，云端
 * 一条都没有却判 pass —— 两边差的不是质量，是「知不知道自己丢了东西」。
 *
 * 判的是证据不是损失：probe 看到了，产物没提到，仅此而已。所以文案说的是「无法确认」，
 * 而不是断言内容已丢。按引擎分叉会让这条永远只盯着云端，本地哪天回退同样必须报。
 */
export function crossCheckEmbeddedObjects(candidate: ParseCandidate, probe?: DeckProbeReport): void {
  if (!probe || !EMBEDDED_FORMATS.has(candidate.ir.format)) return;
  const partCount = ['powerpoint.chart_part_count', 'powerpoint.smartart_data_part_count']
    .map((target) => exactValue(probe, target))
    .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    .reduce((sum, value) => sum + value, 0);
  if (partCount === 0 && exactValue(probe, 'security.has_embedded_files') !== true) return;
  const quality = candidate.ir.quality;
  if (quality.checks.some((check) => EMBEDDED_REPORTED.has(check.code))) return;
  const represented = candidate.ir.document.nodes.filter((node) => EMBEDDED_TYPES.has(node.type)).length;
  // 数个数而不是「有没有」：一份文档里 1 张图表 + 1 个 SmartArt，产物只给出一个图表空壳，
  // 布尔判据会就此收声，SmartArt 与嵌入对象的缺失就再没人提。部件数拿不到时退回布尔判据。
  if (partCount > 0 ? represented >= partCount : represented > 0) return;
  quality.checks.push({ code: 'embedded_object_undetected', severity: 'warning',
    message: `The source contains embedded objects${partCount ? ` (${partCount} chart/SmartArt parts, ${represented} represented)` : ''}, but this result neither represents nor reports them; their content cannot be confirmed present.`,
    ...(partCount ? { detail: { parts: partCount, represented } } : {}) });
  quality.status = 'degraded';
  // 适配器把同一个 quality 对象同时挂在 candidate 与 ir 上；显式对齐，不依赖这个巧合。
  candidate.quality = quality;
}

export function textOnPage(ir: DeckIR, page: number): number { return bodyTextStats(ir).pages.get(page) ?? 0; }
/** Check observed regressions and resolved defects, without a semantic model or provider score. */
export function improvesCandidate(local: ParseCandidate, cloud: ParseCandidate, before: Assessment, after: Assessment): boolean {
  if (local.ir.source.sha256 !== cloud.ir.source.sha256 || local.ir.format !== cloud.ir.format) return false;
  const relevant = (a: Assessment) => a.issues.filter(i => i.severity !== 'info' && i.impact !== 'informational');
  const previous = relevant(before), next = relevant(after);
  if (!previous.length || !after.summary?.searchableTextCharacters) return false;
  if (next.some(i => !previous.some(old => old.code === i.code && old.severity === i.severity))) return false;
  if (before.scope.pages.some(p => !after.scope.pages.includes(p))) return false;
  const expected = before.summary?.sourcePages;
  if (expected !== undefined && before.summary?.missingPageCount && after.scope.pages.filter(p => p >= 1 && p <= expected).length < expected && !next.some(i => i.code === 'source_page_count_mismatch')) return false;
  if ((after.summary?.missingPageCount ?? 0) > (before.summary?.missingPageCount ?? 0) || (after.summary?.failedPages.length ?? 0) > (before.summary?.failedPages.length ?? 0)) return false;
  const assets = new Set(cloud.assets.map(candidateAssetOutputPath));
  if (cloud.ir.document.assets.some(a => !assets.has(a.path))) return false;
  const resolved = previous.filter(i => !next.some(n => n.code === i.code));
  if (!resolved.length) return false;
  const stats = bodyTextStats(cloud.ir);
  return resolved.every(i => !['ocr_required', 'page_parse_failed', 'missing_slide'].includes(i.code) || !!i.pages?.length && i.pages.every(p => (stats.pages.get(p) ?? 0) > 0));
}
