export const BASE_RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 60_000;
export const MAX_RETRY_ATTEMPTS = 10;
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface RetrySchedule {
  readonly delayMs: number;
  readonly exhausted: boolean;
}

/**
 * Computes the next retry delay without reading process state. `random` must
 * return a value in [0, 1]; injecting it keeps the policy deterministic in
 * tests while callers can pass `Math.random` in production.
 */
export function computeRetrySchedule(
  attempt: number,
  random: () => number,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): RetrySchedule {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("Retry attempt must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new RangeError(`Retry maximum must be an integer from 1 to ${MAX_RETRY_ATTEMPTS}.`);
  }

  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new RangeError("Retry randomness must be a finite value from 0 to 1.");
  }

  const exponentialDelay = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
  const delayMs = Math.round(exponentialDelay * (0.5 + randomValue * 0.5));

  return { delayMs, exhausted: attempt >= maxAttempts };
}
