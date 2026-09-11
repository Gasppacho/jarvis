import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ATTEMPTS, computeRetrySchedule } from "./retry-policy.js";

describe("computeRetrySchedule", () => {
  it("grows the delay exponentially by attempt", () => {
    const delays = [1, 2, 3, 4].map((attempt) => computeRetrySchedule(attempt, () => 1).delayMs);

    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it("pins the jitter bounds for an attempt", () => {
    expect(computeRetrySchedule(3, () => 0).delayMs).toBe(2000);
    expect(computeRetrySchedule(3, () => 1).delayMs).toBe(4000);
  });

  it("never exceeds the hard maximum delay", () => {
    expect(computeRetrySchedule(100, () => 1).delayMs).toBe(60000);
    expect(computeRetrySchedule(100, () => 0).delayMs).toBe(30000);
  });

  it("can produce different delays with real randomness", () => {
    const delays = new Set(
      Array.from({ length: 20 }, () => computeRetrySchedule(1, Math.random).delayMs),
    );

    expect(delays.size).toBeGreaterThan(1);
  });

  it("reports exhaustion against the default and caller-selected bounds", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
    expect(computeRetrySchedule(4, () => 0).exhausted).toBe(false);
    expect(computeRetrySchedule(5, () => 0).exhausted).toBe(true);
    expect(computeRetrySchedule(2, () => 0, 2).exhausted).toBe(true);
    expect(computeRetrySchedule(6, () => 0, 7).exhausted).toBe(false);
    expect(computeRetrySchedule(7, () => 0, 7).exhausted).toBe(true);
  });
});
