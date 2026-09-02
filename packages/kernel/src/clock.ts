/** Controllable wall clock shared by persistence boundaries. */
export interface Clock {
  now(): Date;
}

/** Production adapter; tests inject a fixed clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
