import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RETRY_DELAYS_MS,
  RetryError,
  defaultIsTransient,
  retryWithBackoff,
} from '../../../src/utils/retry.js';

describe('DEFAULT_RETRY_DELAYS_MS', () => {
  it('is [30s, 2m, 5m] per AC', () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 300_000]);
  });
});

describe('defaultIsTransient', () => {
  it.each([
    ['ENOTFOUND', { code: 'ENOTFOUND' }, true],
    ['ECONNREFUSED', { code: 'ECONNREFUSED' }, true],
    ['ETIMEDOUT', { code: 'ETIMEDOUT' }, true],
    ['ECONNRESET', { code: 'ECONNRESET' }, true],
    ['HTTP 500', { status: 500 }, true],
    ['HTTP 503', { status: 503 }, true],
    ['HTTP 429 rate limit', { status: 429 }, true],
    ['HTTP 408 request timeout', { status: 408 }, true],
    ['HTTP 400 bad request', { status: 400 }, false],
    ['HTTP 401 unauthorized', { status: 401 }, false],
    ['HTTP 403 forbidden (default)', { status: 403 }, false],
    ['HTTP 404 not found', { status: 404 }, false],
    ['HTTP 409 conflict', { status: 409 }, false],
    ['response.status nested shape', { response: { status: 503 } }, true],
  ])('%s → transient=%s', (_label, err, expected) => {
    expect(defaultIsTransient(err)).toBe(expected);
  });

  it('returns true for Error messages containing "timeout"', () => {
    expect(defaultIsTransient(new Error('connection timed out'))).toBe(true);
    expect(defaultIsTransient(new Error('Network unreachable'))).toBe(true);
  });

  it('returns false for null/undefined (defensive)', () => {
    expect(defaultIsTransient(null)).toBe(false);
    expect(defaultIsTransient(undefined)).toBe(false);
  });
});

describe('retryWithBackoff', () => {
  it('returns immediately on first-attempt success without sleeping', async () => {
    const fn = vi.fn(async () => 'ok');
    const sleep = vi.fn(async () => {});
    const result = await retryWithBackoff(fn, { sleep, retryDelaysMs: [10, 20, 30] });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries transient failures up to N attempts and returns once any succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('flaky'), { code: 'ETIMEDOUT' });
      return 'ok';
    });
    const sleep = vi.fn(async () => {});
    const result = await retryWithBackoff(fn, { sleep, retryDelaysMs: [10, 20, 30] });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    // Two sleeps between three attempts (the 3rd succeeds → no trailing sleep).
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it('re-throws immediately on permanent failure without retrying', async () => {
    const permanent = Object.assign(new Error('bad request'), { status: 400 });
    const fn = vi.fn(async () => {
      throw permanent;
    });
    const sleep = vi.fn(async () => {});
    await expect(retryWithBackoff(fn, { sleep, retryDelaysMs: [10, 20, 30] })).rejects.toBe(
      permanent,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('after exhausting all attempts on transient errors, throws RetryError with attempt summary', async () => {
    const transient = Object.assign(new Error('still timing out'), { code: 'ETIMEDOUT' });
    const fn = vi.fn(async () => {
      throw transient;
    });
    const sleep = vi.fn(async () => {});
    await expect(
      retryWithBackoff(fn, { sleep, retryDelaysMs: [10, 20, 30] }),
    ).rejects.toBeInstanceOf(RetryError);
    expect(fn).toHaveBeenCalledTimes(3);

    try {
      await retryWithBackoff(fn, { sleep, retryDelaysMs: [10, 20, 30] });
    } catch (err) {
      expect(err).toBeInstanceOf(RetryError);
      const re = err as RetryError;
      expect(re.attempts).toHaveLength(3);
      expect(re.attempts.every((a) => a.transient)).toBe(true);
      expect(re.lastError).toBe(transient);
    }
  });

  it('respects custom isTransient classifier (Cline-style 403-as-rate-limit override)', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw Object.assign(new Error('rate limited'), { status: 403 });
      return 'ok';
    });
    const sleep = vi.fn(async () => {});
    const result = await retryWithBackoff(fn, {
      sleep,
      retryDelaysMs: [10, 20, 30],
      // Treat 403 as transient (Cline's rate-limit shape).
      isTransient: (e) => (e as { status?: number }).status === 403,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('invokes onAttempt callback for observability with the will-retry decision', async () => {
    const events: Array<{ attempt: number; willRetry: boolean; delayMs: number }> = [];
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
      return 'ok';
    });
    await retryWithBackoff(fn, {
      sleep: async () => {},
      retryDelaysMs: [10, 20, 30],
      onAttempt: ({ attempt, willRetry, delayMs }) => {
        events.push({ attempt, willRetry, delayMs });
      },
    });
    expect(events).toEqual([
      { attempt: 1, willRetry: true, delayMs: 10 },
      { attempt: 2, willRetry: true, delayMs: 20 },
    ]);
  });
});
