import { RpcError, RpcExhaustedError } from '../domain/errors.js';

export interface RetryPolicy {
  /** Total tries, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryHooks {
  sleep: (ms: number) => Promise<void>;
  onRetry?: (info: { operation: string; attempt: number; delayMs: number; error: RpcError }) => void;
}

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded exponential backoff for transient provider errors only (`RpcError.retryable`).
 * Anything else, including an injected crash or a programming error, propagates untouched.
 * There is no jitter on purpose: it keeps scenarios deterministic. A multi-process deployment
 * would want jitter (see docs/known-limitations.md).
 */
export async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RpcError) || !err.retryable) throw err;
      if (attempt >= policy.maxAttempts) throw new RpcExhaustedError(operation, attempt, err);
      const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      hooks.onRetry?.({ operation, attempt, delayMs, error: err });
      await hooks.sleep(delayMs);
    }
  }
}
