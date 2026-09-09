import { DeckOpsError } from '../errors/index.js';
import type { CommonFlags, ParseFlags } from '../types.js';
import type { Assessment } from '../quality/assessment.js';
import type { EngineParseInput } from './types.js';
import type { DeckProbeReport } from '../shared/preflight.js';

export const CAPABILITIES = {
  schemaVersion: 'deckops.capabilities.v1',
  local: { formats: ['pdf', 'pptx', 'docx', 'html'], features: ['text', 'tables', 'images'], ocr: false, upload: 'none' },
  cloud: { provider: 'deckflow', formats: ['pdf', 'pptx', 'docx', 'keynote', 'html'], uploadScope: 'entire_document', paid: true,
    costBound: 'unavailable', source: 'bundled cloud parse API contract',
    features: [
      { id: 'document_parse', status: 'supported', autoEligible: true },
      { id: 'keynote_parse', status: 'supported', autoEligible: true },
      { id: 'runtime_html', status: 'supported', autoEligible: true },
      { id: 'ocr', status: 'unverified', autoEligible: false },
      { id: 'table_structure', status: 'unverified', autoEligible: false },
      { id: 'chart_content', status: 'unverified', autoEligible: false },
      { id: 'smartart_content', status: 'unverified', autoEligible: false },
      { id: 'visual_layout', status: 'unverified', autoEligible: false },
      { id: 'embedded_content', status: 'unverified', autoEligible: false },
    ],
    unsupportedParameters: ['trackedChanges', 'pageFurniture', 'overlaidText'],
  },
} as const;
export type { ExecutionPolicy, RouteDecision } from '../shared/policy-types.js';
import type { ExecutionPolicy, RouteDecision } from '../shared/policy-types.js';
export function compilePolicy(common: CommonFlags): ExecutionPolicy {
  const engine = common.engine ?? 'local';
  if (!['local', 'auto', 'cloud'].includes(engine)) throw DeckOpsError.usage('Invalid engine mode.');
  for (const value of [common.cloudLimits?.maxSourceBytes, common.cloudLimits?.maxSourcePages]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw DeckOpsError.usage('Cloud source limits must be positive integers.');
  }
  return { version: 1, engine, upload: engine === 'cloud' && common.allowUpload !== false || engine === 'auto' && common.allowUpload === true ? 'allow' : 'deny', acceptance: common.failOnDegraded ? 'no-degraded' : 'best-effort', maxParseSubmissions: 1, source: common.policySource ?? { engine: common.engine ? 'api' : 'builtin', allowUpload: common.allowUpload !== undefined ? 'api' : 'builtin' } };
}
export function cloudSupport(input: EngineParseInput, flags: ParseFlags): { supported: boolean; reason?: string } {
  if (flags.trackedChanges !== undefined || flags.pageFurniture !== undefined || flags.overlaidText !== undefined) return { supported: false, reason: 'parameter_incompatible' };
  return { supported: input.input.kind === 'link' || ['pdf.pdfParse', 'pptx.parse', 'docx.parseTextAndImage', 'keynote.parseTextAndImage'].includes(input.input.taskType) };
}
export function evaluatePolicy(input: EngineParseInput, flags: ParseFlags, common: CommonFlags, assessment?: Assessment, unsupported = false, probe?: DeckProbeReport): RouteDecision {
  const policy = compilePolicy(common);
  const needed = unsupported ? ['document_parse'] : [...new Set(assessment?.issues.filter(i => i.severity !== 'info' && i.impact !== 'informational' && i.impact !== 'delivery').flatMap(i => i.neededCapability ? [i.neededCapability] : []) ?? [])];
  const alternatives: RouteDecision['alternatives'] = needed.map(capability => ({ engine: 'cloud', capability, verification: CAPABILITIES.cloud.features.find(f => f.id === capability)?.status ?? 'unverified', uploadScope: 'entire_document', requires: ['upload_authorization', 'credentials'] }));
  const hasIssues = assessment?.issues.some(i => i.severity !== 'info' && i.impact !== 'informational');
  let reason = hasIssues ? 'no_verified_remedy' : 'no_relevant_issue'; let action: RouteDecision['action'] = 'keep_local';
  if (policy.engine === 'cloud') { action = 'use_cloud'; reason = 'explicit_cloud'; }
  else if (needed.length) {
    if (policy.engine === 'local') reason = 'local_only';
    else if (policy.upload === 'deny') reason = 'upload_denied';
    else if (!cloudSupport(input, flags).supported) reason = 'parameter_incompatible';
    else if (!needed.every(id => CAPABILITIES.cloud.features.some(f => f.id === id && f.autoEligible))) reason = 'capability_unverified';
    else { action = 'upgrade'; reason = unsupported ? 'unsupported_local' : 'quality_gap'; }
  }
  if (action !== 'keep_local') {
    if (policy.upload === 'deny') { action = 'keep_local'; reason = 'upload_denied'; }
    else if (!cloudSupport(input, flags).supported) { action = 'keep_local'; reason = 'parameter_incompatible'; }
    else if (common.cloudLimits?.maxCost !== undefined) { action = 'keep_local'; reason = 'budget_unverifiable'; }
    else if (common.cloudLimits?.maxSourceBytes !== undefined && (input.input.kind === 'link' || !input.source || input.source.bytes > common.cloudLimits.maxSourceBytes)) { action = 'keep_local'; reason = input.input.kind === 'link' ? 'limit_unverifiable' : 'source_byte_limit'; }
    else if (common.cloudLimits?.maxSourcePages !== undefined) {
      const key = input.input.kind !== 'link' && input.input.taskType === 'pdf.pdfParse' ? 'pdf.page_count' : 'powerpoint.slide_count';
      const evidence = probe?.results[key];
      if (evidence?.status !== 'resolved' || evidence.confidence !== 'exact' || typeof evidence.value !== 'number') { action = 'keep_local'; reason = 'limit_unverifiable'; }
      else if (evidence.value > common.cloudLimits.maxSourcePages) { action = 'keep_local'; reason = 'source_page_limit'; }
    }
  }
  // A recommendation is visible even when policy keeps this run local. Do not drop
  // parameters or hard limits from a suggested command, or serialize a password.
  const recommend = assessment?.recommendation || alternatives.length;
  const commandSafe = cloudSupport(input, flags).supported && !flags.password && !common.cloudLimits && !common.limits;
  const argv = ['deckops', '--engine', 'cloud'];
  if (flags.profile !== undefined) argv.push('--profile', flags.profile);
  if (flags.includeImages === false) argv.push('--no-images');
  if (flags.mode !== undefined) argv.push('--mode', flags.mode);
  if (flags.stayImageAreaRate !== undefined) argv.push('--stay-image-area-rate', String(flags.stayImageAreaRate));
  argv.push('--', input.inputLabel);
  return { action, reason, policy, alternatives, attempts: [], ...(recommend && action === 'keep_local' ? {
    next: { argv: commandSafe ? argv : ['deckops', 'capabilities', '--json'],
      message: commandSafe ? 'Optional paid cloud run; execute only with upload authorization. Listed unverified remedies are not guaranteed.' : 'Inspect cloud capabilities; preserve source parameters and limits when choosing a compatible cloud run.' },
  } : {}) };
}
