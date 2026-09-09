import { DeckOpsError } from '../errors/index.js';
import type { ParseCandidate } from '../ir/schema.js';
import { CloudEngine } from './cloud.js';
import { LocalEngine } from './local.js';
import type { EngineParseInput, EngineParseOptions } from './types.js';
import type { CloudClient } from '../cloud/client.js';
import { assessCandidate, improvesCandidate, type Assessment } from '../quality/assessment.js';
import { evaluatePolicy, type RouteDecision } from './policy.js';
import type { DeckProbeReport } from '../shared/preflight.js';

export async function routeParse(options: {
  input: EngineParseInput; parse: EngineParseOptions; cloud?: () => Promise<CloudClient>; signal: AbortSignal;
  probe?: DeckProbeReport; cached?: ParseCandidate; cachedCloud?: ParseCandidate;
  previousSubmission?: { status: string; taskId?: string };
  onSubmission?: (state: { status: string; taskId?: string }) => void;
  onCandidate?: (candidate: ParseCandidate) => Promise<void>;
  onTask?: (task: { id: string }) => void;
}): Promise<ParseCandidate> {
  options.signal.throwIfAborted();
  const mode = options.parse.common.engine ?? 'local';
  const local = new LocalEngine();
  const support = local.supports(options.input, options.parse);
  let candidate: ParseCandidate | undefined;
  if (mode !== 'cloud' && support.supported) {
    candidate = options.cached?.ir.producer.engine === 'local' ? options.cached : await local.parse(options.input, options.parse, options.signal);
    options.signal.throwIfAborted();
    await options.onCandidate?.(candidate);
  }
  let assessment = candidate ? assessCandidate(candidate, options.probe) : undefined;
  const decision = evaluatePolicy(options.input, options.parse.flags, options.parse.common, assessment, !support.supported, options.probe);
  if (decision.action !== 'keep_local' && options.previousSubmission && !options.cachedCloud && options.cached?.ir.producer.engine !== 'cloud') {
    decision.action = 'keep_local'; decision.reason = 'previous_submission_pending';
    decision.attempts.push({ engine: 'cloud', ...options.previousSubmission });
    if (mode === 'cloud' || !candidate) throw DeckOpsError.backend('A previous cloud submission is unresolved. Resume/check its task before submitting again.', options.previousSubmission.taskId ? { taskId: options.previousSubmission.taskId } : {});
  }
  if (decision.action !== 'keep_local') {
    const attempt: RouteDecision['attempts'][number] = { engine: 'cloud', status: 'starting' };
    decision.attempts.push(attempt);
    try {
      options.signal.throwIfAborted();
      const reusableCloud = options.cachedCloud ?? (options.cached?.ir.producer.engine === 'cloud' ? options.cached : undefined);
      if (!options.cloud && !reusableCloud) throw DeckOpsError.usage('Cloud parsing was requested but no cloud client is configured.');
      const client = reusableCloud ? undefined : await options.cloud!();
      options.signal.throwIfAborted();
      attempt.status = reusableCloud ? 'cache_hit' : 'submission_unknown';
      if (!reusableCloud) options.onSubmission?.({ status: 'submission_unknown' });
      const cloud = reusableCloud ?? await new CloudEngine(client!).parse(options.input, { ...options.parse, onTask: task => { attempt.taskId = task.id; attempt.status = 'submitted'; options.onSubmission?.({ status: 'submitted', taskId: task.id }); options.onTask?.(task); } }, options.signal);
      options.signal.throwIfAborted();
      const after = assessCandidate(cloud, options.probe, assessment?.summary?.sourcePages);
      await options.onCandidate?.(cloud);
      attempt.status = reusableCloud ? 'cache_hit' : 'completed';
      if (!reusableCloud) options.onSubmission?.({ status: 'completed', ...(attempt.taskId ? { taskId: attempt.taskId } : {}) });
      if (!candidate || mode === 'cloud' || improvesCandidate(candidate, cloud, assessment!, after)) { candidate = cloud; assessment = after; decision.reason = mode === 'cloud' ? 'explicit_cloud' : 'quality_improved'; }
      else { decision.action = 'keep_local'; decision.reason = 'comparison_inconclusive'; }
    } catch (error) {
      // Explicit cancellation stops publication; an upgrade timeout may retain a ready local candidate.
      if (options.parse.common.signal?.aborted) throw error;
      if (!candidate || mode === 'cloud') throw error;
      if (attempt.status !== 'submission_unknown') attempt.status = 'failed';
      decision.action = 'keep_local'; decision.reason = 'upgrade_failed';
      candidate.warnings = [...(candidate.warnings ?? []), `Cloud upgrade failed; kept local result (${error instanceof DeckOpsError ? error.code : 'backend_error'}).`];
    }
  }
  if (!candidate || !assessment) throw DeckOpsError.unsupported(support.reason ?? decision.reason, { hint: `Cloud route blocked: ${decision.reason}. Inspect deckops capabilities --json.` });
  candidate.assessment = assessment; candidate.decision = decision;
  finalQualityGate(candidate, options.parse.common.failOnDegraded);
  return candidate;
}
export function finalQualityGate(candidate: { quality: ParseCandidate['quality']; assessment?: Assessment }, strict?: boolean): void {
  if (strict && (candidate.quality.status !== 'pass' || candidate.assessment?.status === 'needs_attention')) throw DeckOpsError.input('Final result does not meet the requested quality gate.', { hint: candidate.assessment?.issues[0]?.message ?? candidate.quality.checks[0]?.message ?? 'See the quality report.' });
}
