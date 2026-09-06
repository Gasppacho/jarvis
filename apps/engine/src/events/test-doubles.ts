import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type { IdGenerator } from "../../../../packages/kernel/src/id-generator.js";

/**
 * docs/engineering/TEST_FIXTURES.md "Clocks and IDs": the Application Harness
 * injects a controllable clock and deterministic id generator so tests never
 * assert against wall-clock/random output. Built here for ticket #56's
 * eventing tests; promote if a later ticket needs the same doubles elsewhere.
 */
export class ControllableClock implements Clock {
  public constructor(private current: Date) {}

  public now(): Date {
    return this.current;
  }

  public advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class DeterministicIdGenerator implements IdGenerator {
  private counter = 0;

  public next(): string {
    this.counter += 1;
    return `test${this.counter.toString().padStart(6, "0")}`;
  }
}
