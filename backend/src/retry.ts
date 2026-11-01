/**
 * RETRY WITH EXPONENTIAL BACKOFF
 * For Google API calls: retries on rate limits (429, 403 rateLimitExceeded)
 * and server errors (5xx), waiting 1s, 2s, 4s, 8s… plus a little jitter.
 * Anthropic calls use the SDK's own built-in retry (same idea).
 */
export interface RetryOptions { retries?: number; baseMs?: number; maxMs?: number; isRetryable?: (e: unknown) => boolean }

export function isRetryableHttp(e: unknown): boolean {
  const err = e as { code?: number | string; status?: number; response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } } };
  const status = Number(err?.response?.status ?? err?.status ?? err?.code);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const reason = err?.response?.data?.error?.errors?.[0]?.reason;
  if (status === 403 && (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded")) return true;
  return ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(String(err?.code));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 5, baseMs = 1000, maxMs = 30000, isRetryable = isRetryableHttp } = opts;
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      const wait = Math.min(maxMs, baseMs * 2 ** attempt) * (0.8 + Math.random() * 0.4);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
