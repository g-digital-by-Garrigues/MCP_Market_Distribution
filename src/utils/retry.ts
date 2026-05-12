// Story 4.1: shared retry-with-backoff utility for every external call in
// Epic 4 publishers (Smithery API, gh PR/issue creation, mcp.so issue).
//
// The 3-attempt [30s, 2m, 5m] pattern matches the idempotency check
// (Story 3.1) so engineers see consistent semantics across the pipeline.
// Stories 4.2-4.5 wrap their external calls in this helper.
//
// Transient vs permanent classification:
//   - Transient: network errors (ENOTFOUND, ECONNREFUSED, ETIMEDOUT,
//     ECONNRESET, EAI_AGAIN), 5xx HTTP, 429 rate limit, 503 unavailable.
//     These get retried.
//   - Permanent: 4xx other than 429 (400 bad request, 401 unauthorized,
//     403 forbidden, 404 not found, 409 conflict). The retry helper
//     re-throws immediately so callers see the failure without burning
//     7.5 minutes of backoff on a request that's never going to succeed.
//
// The caller can override `isTransient` for cases where the default
// heuristic doesn't fit — e.g. Cline's 403 rate-limit response is
// classified as transient (against the default), so Story 4.4 passes a
// custom `isTransient` that treats 403 as transient.

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 300_000];

export interface AttemptSummary {
  /** 1-indexed attempt number. */
  attempt: number;
  /** Error from the failed attempt, stringified. */
  error: string;
  /** Whether this attempt was classified as transient (and thus retried). */
  transient: boolean;
}

export class RetryError extends Error {
  readonly attempts: readonly AttemptSummary[];
  readonly lastError: unknown;
  constructor(message: string, attempts: readonly AttemptSummary[], lastError: unknown) {
    super(message);
    this.name = 'RetryError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export interface RetryOptions {
  /** Override per-attempt delays. Length determines max attempts (default 3). */
  retryDelaysMs?: readonly number[];
  /** Custom transient classifier (default: built-in heuristic). */
  isTransient?: (err: unknown) => boolean;
  /** Inject for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional callback for observability (logger.info hook). */
  onAttempt?: (info: { attempt: number; willRetry: boolean; delayMs: number; error: unknown }) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Built-in classifier. Treats:
//   - Errors whose `code` looks like a Node network error → transient
//   - Errors whose `status` is 5xx, 429, or 408 → transient
//   - Anything else → permanent
export function defaultIsTransient(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const anyErr = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const code = typeof anyErr.code === 'string' ? anyErr.code : undefined;
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH'
  ) {
    return true;
  }
  const status =
    typeof anyErr.status === 'number'
      ? anyErr.status
      : typeof anyErr.response?.status === 'number'
      ? anyErr.response.status
      : undefined;
  if (status !== undefined) {
    if (status >= 500 && status < 600) return true;
    if (status === 408 || status === 429) return true;
    return false;
  }
  // Fallback: inspect message for known transient phrasings.
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|ETIMEDOUT|network/i.test(message)) return true;
  return false;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxAttempts = delays.length;
  const sleep = options.sleep ?? defaultSleep;
  const isTransient = options.isTransient ?? defaultIsTransient;

  const attempts: AttemptSummary[] = [];
  let lastError: unknown = new Error('retryWithBackoff invoked with empty retryDelaysMs');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = isTransient(err);
      attempts.push({
        attempt,
        error: err instanceof Error ? err.message : String(err),
        transient,
      });
      lastError = err;
      if (!transient) {
        // Permanent failure — re-throw immediately. Don't waste backoff time.
        throw err;
      }
      if (attempt < maxAttempts) {
        const delayMs = delays[attempt - 1]!;
        options.onAttempt?.({ attempt, willRetry: true, delayMs, error: err });
        await sleep(delayMs);
        continue;
      }
      options.onAttempt?.({ attempt, willRetry: false, delayMs: 0, error: err });
    }
  }

  throw new RetryError(
    `retryWithBackoff exhausted ${maxAttempts} attempts; last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    attempts,
    lastError,
  );
}
