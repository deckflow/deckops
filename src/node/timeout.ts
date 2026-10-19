import { DeckOpsError } from '../errors/index.js';

/**
 * 在整体时限内跑一个操作；时限到了就说清楚停在了哪、下一步怎么办。
 *
 * 时限原先只以 AbortSignal 的原因冒出来：「The operation was aborted due to timeout」。实测测试
 * 环境的域名在本机连不上，请求还在按 30 秒一次重试，命令等满 120 秒后只剩这一句，看不出是文档
 * 太大、云端太慢还是根本没连上。调用方自己的取消信号照原样抛出。
 */
export async function withinOperationTimeout<T>(ms: number, userSignal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>, extraHint?: string): Promise<T> {
  const timeout = AbortSignal.timeout(ms);
  const signal = userSignal ? AbortSignal.any([userSignal, timeout]) : timeout;
  try {
    return await run(signal);
  } catch (error) {
    if (timeout.aborted && !userSignal?.aborted && causedByTimeout(error)) {
      throw DeckOpsError.backend(`Stopped after ${Math.round(ms / 1000)}s without a result.`, {
        hint: [
          'Raise --timeout for a large document.',
          extraHint,
          'If the API root may be unreachable from here, `deckops config list` shows which one is in use.',
        ].filter(Boolean).join(' '),
        cause: error,
      });
    }
    throw error;
  }
}

function causedByTimeout(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    if (current.name === 'TimeoutError' || current.message === 'The operation was aborted due to timeout') return true;
  }
  return false;
}
