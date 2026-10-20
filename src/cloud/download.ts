import { delay, throwIfAborted } from './abort.js';
import { getRetryDelaysMs } from './errors.js';

/** A signed result URL could not be fetched. The message never carries the signature. */
export class DownloadError extends Error {
  constructor(message: string, readonly status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DownloadError';
  }
}

/**
 * GET a signed result URL. Signed URLs authorize themselves, so no credentials are sent and
 * cookies stay out of it. Gateway and network failures are retried; a 403 or 404 is final.
 */
export async function fetchSigned(url: string, signal?: AbortSignal): Promise<Response> {
  const delays = getRetryDelaysMs().slice(0, 2);
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await fetch(url, { credentials: 'omit', ...(signal ? { signal } : {}) });
    } catch (error) {
      throwIfAborted(signal);
      failure = error;
    }
    if (response?.ok) return response;
    const retriable = response === undefined || response.status >= 500 || response.status === 429;
    if (!retriable || attempt >= delays.length) {
      await response?.body?.cancel().catch(() => {});
      const reason = response ? `HTTP ${response.status}` : failure instanceof Error ? failure.message : String(failure);
      throw new DownloadError(`Cannot download ${redact(url)}: ${reason}`, response?.status, failure === undefined ? undefined : { cause: failure });
    }
    await response?.body?.cancel().catch(() => {});
    await delay(delays[attempt]!, signal);
  }
}

export async function fetchSignedText(url: string, signal?: AbortSignal): Promise<string> {
  return await (await fetchSigned(url, signal)).text();
}

export async function fetchSignedJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const text = await fetchSignedText(url, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new DownloadError(`${redact(url)} did not return JSON.`, undefined, { cause });
  }
}

export async function fetchSignedBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  return await (await fetchSigned(url, signal)).blob();
}

/** Origin and path only: the query of a signed URL is the credential. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}
