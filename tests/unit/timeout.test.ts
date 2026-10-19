import { describe, expect, it } from 'vitest';
import { operationTimeoutMs } from '../../src/node/parse-op.js';
import { withinOperationTimeout } from '../../src/node/timeout.js';

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

describe('operation timeout option', () => {
  it('accepts fractional seconds and rejects what is not a positive finite duration', () => {
    expect(operationTimeoutMs({})).toBe(120_000);
    expect(operationTimeoutMs({ timeout: 1.1 })).toBe(1100);
    expect(operationTimeoutMs({ timeout: 0.0004 })).toBe(1);
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 3e6, '5' as never]) {
      expect(() => operationTimeoutMs({ timeout })).toThrow(expect.objectContaining({ code: 'usage_error' }));
    }
  });
});
