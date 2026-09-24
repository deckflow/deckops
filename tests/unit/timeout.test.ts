import { describe, expect, it } from 'vitest';
import { withinOperationTimeout } from '../../src/core/timeout.js';

/** 一个只在信号中止时才结束的操作，像一次连不上的请求。 */
const waitForAbort = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

describe('operation timeout', () => {
  it('says how long it waited and what to try instead of a bare abort message', async () => {
    // 实测：测试环境的域名连不上，命令等满 120 秒后只剩「The operation was aborted due to timeout」。
    const error = await withinOperationTimeout(20, undefined, waitForAbort, 'If a cloud task was created, rerunning the same command resumes it.')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'backend_error', message: 'Stopped after 0s without a result.' });
    expect((error as { hint: string }).hint).toMatch(/--timeout.*resumes it.*deckops config list/);
  });

  it('passes the caller\'s own cancellation through unchanged', async () => {
    const controller = new AbortController();
    const running = withinOperationTimeout(10_000, controller.signal, waitForAbort);
    controller.abort(new Error('cancelled by caller'));
    await expect(running).rejects.toThrow('cancelled by caller');
  });
});
