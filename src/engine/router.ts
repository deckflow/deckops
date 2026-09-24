import { DeckOpsError } from '../errors/index.js';
import type { ParseCandidate } from '../ir/schema.js';
import { CloudEngine } from './cloud.js';
import { LocalEngine } from './local.js';
import type { EngineParseInput, EngineParseOptions } from './types.js';
import type { CloudClient } from '../cloud/client.js';
import { assessCandidate, crossCheckEmbeddedObjects, improvesCandidate, type Assessment } from '../quality/assessment.js';
import { evaluatePolicy, type RouteDecision } from './policy.js';
import type { DeckProbeReport } from '../shared/preflight.js';

export async function routeParse(options: {
  input: EngineParseInput; parse: EngineParseOptions; cloud?: () => Promise<CloudClient>; signal: AbortSignal;
  probe?: DeckProbeReport; cached?: ParseCandidate; cachedCloud?: ParseCandidate;
  previousSubmission?: { status: string; taskId?: string; spaceId?: string };
  onSubmission?: (state: { status: string; taskId?: string; spaceId?: string }) => void;
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
  // 源与产物的交叉核对要在评估之前做：新增的 check 才能一并进 assessment 的 issues。
  if (candidate) crossCheckEmbeddedObjects(candidate, options.probe);
  let assessment = candidate ? assessCandidate(candidate, options.probe) : undefined;
  const decision = evaluatePolicy(options.input, options.parse.flags, options.parse.common, assessment, !support.supported, options.probe);
  // 上一次提交没有结果。拿到过任务 id 就接着等那个任务、取回结果，不重新上传也不重新计费——原先
  // 只能挡住，唯一的出路是 --force 再交一次钱（实测下载结果时断网一次，就得重解析一遍）。没拿到
  // id 无从查起，默认不再提交，免得同一份文件算两次钱；`--force` 明说要重做，放行并留一条警告。
  const unresolved = decision.action !== 'keep_local' && options.previousSubmission && !options.cachedCloud && options.cached?.ir.producer.engine !== 'cloud'
    ? options.previousSubmission : undefined;
  const force = Boolean(options.parse.common.force);
  const resumable = unresolved?.taskId && !force ? { taskId: unresolved.taskId, ...(unresolved.spaceId ? { spaceId: unresolved.spaceId } : {}) } : undefined;
  if (unresolved && !force && !resumable) {
    decision.action = 'keep_local'; decision.reason = 'previous_submission_pending';
    decision.attempts.push({ engine: 'cloud', status: unresolved.status });
    if (mode === 'cloud' || !candidate) {
      throw DeckOpsError.backend('A previous cloud submission may have reached the cloud, but no task id came back.', {
        hint: 'Run again with --force to resubmit; if the earlier task was created, it may be billed separately.',
      });
    }
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
      if (reusableCloud) attempt.status = 'cache_hit';
      else if (resumable) { attempt.status = 'resuming'; attempt.taskId = resumable.taskId; }
      // 建任务的请求真正发出时才记成 submission_unknown。原先连上云之前就记，取空间时网络
      // 不通也会留下一条「提交未决」，之后每次解析都被它挡住，而云端根本没有这个任务。
      const cloud = reusableCloud ?? (resumable
        ? await new CloudEngine(client!).resume(options.input, resumable, options.parse, options.signal)
        : await new CloudEngine(client!).parse(options.input, { ...options.parse,
          onSubmit: () => { attempt.status = 'submission_unknown'; options.onSubmission?.({ status: 'submission_unknown' }); },
          onTask: task => {
            attempt.taskId = task.id; attempt.status = 'submitted';
            options.onSubmission?.({ status: 'submitted', taskId: task.id, ...(task.spaceId ? { spaceId: task.spaceId } : {}) });
            options.onTask?.(task);
          } }, options.signal));
      options.signal.throwIfAborted();
      crossCheckEmbeddedObjects(cloud, options.probe);
      const after = assessCandidate(cloud, options.probe, assessment?.summary?.sourcePages);
      await options.onCandidate?.(cloud);
      attempt.status = reusableCloud ? 'cache_hit' : 'completed';
      if (!reusableCloud) options.onSubmission?.({ status: 'completed', ...(attempt.taskId ? { taskId: attempt.taskId } : {}) });
      if (!candidate || mode === 'cloud' || improvesCandidate(candidate, cloud, assessment!, after)) { candidate = cloud; assessment = after; decision.reason = mode === 'cloud' ? 'explicit_cloud' : 'quality_improved'; }
      else { decision.action = 'keep_local'; decision.reason = 'comparison_inconclusive'; }
      if (resumable && !reusableCloud) {
        candidate.warnings = [...(candidate.warnings ?? []), `Resumed cloud task ${resumable.taskId} submitted by an earlier run; nothing was uploaded or submitted again.`];
      } else if (unresolved && !reusableCloud) {
        candidate.warnings = [...(candidate.warnings ?? []), `Resubmitted with --force over an unresolved cloud submission${unresolved.taskId ? ` (task ${unresolved.taskId})` : ''}; if that task was created, it may be billed separately.`];
      }
    } catch (error) {
      // 接着等的任务在云端失败了、或已查不到：记成 failed，下一次正常提交；断网、超时则保持原样，下次再接着等。
      const abandoned = resumable && !options.parse.common.signal?.aborted && isTerminalTaskError(error);
      if (abandoned) {
        attempt.status = 'failed';
        options.onSubmission?.({ status: 'failed', taskId: resumable.taskId });
      }
      // 建任务的请求发出去了，服务端却回了 4xx（凭据被拒、额度用完、参数不对）：任务没有建，不是
      // 「提交未决」。原先照记 submission_unknown，重新登录后下一次解析反被它挡住，只能 --force。
      if (attempt.status === 'submission_unknown' && rejectedByServer(error)) {
        attempt.status = 'failed';
        options.onSubmission?.({ status: 'failed' });
      }
      // Explicit cancellation stops publication; an upgrade timeout may retain a ready local candidate.
      if (options.parse.common.signal?.aborted) throw error;
      if (!candidate || mode === 'cloud') {
        if (abandoned) {
          throw DeckOpsError.backend(`The cloud task ${resumable.taskId} from an earlier run cannot be resumed: ${error instanceof Error ? error.message : String(error)}`, {
            taskId: resumable.taskId, hint: 'Run the same command again to submit a new task.', cause: error,
          });
        }
        throw error;
      }
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
/** 服务端回了 4xx：请求被明确拒绝，没有建出任务。5xx 不算，服务端可能在出错前已经建了任务。 */
function rejectedByServer(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    const status = (current as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) return true;
  }
  return false;
}

/**
 * 任务本身的终局：云端报任务失败，或任务、结果已查不到（包括状态接口一直回空——这个身份看不到它）。
 * 网络错误与超时不算，下次还能接着等。
 */
function isTerminalTaskError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    if (/^Task failed:|returned no task status/.test(current.message)) return true;
    const status = (current as { statusCode?: unknown }).statusCode;
    if (status === 403 || status === 404 || status === 410) return true;
    if (current instanceof DeckOpsError && (current.code === 'ir_not_found' || current.code === 'ir_expired')) return true;
  }
  return false;
}

export function finalQualityGate(candidate: { quality: ParseCandidate['quality']; assessment?: Assessment }, strict?: boolean): void {
  if (strict && (candidate.quality.status !== 'pass' || candidate.assessment?.status === 'needs_attention')) throw DeckOpsError.input('Final result does not meet the requested quality gate.', { hint: candidate.assessment?.issues[0]?.message ?? candidate.quality.checks[0]?.message ?? 'See the quality report.' });
}
