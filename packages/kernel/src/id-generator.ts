import { randomUUID } from "node:crypto";

/**
 * Controllable id source shared by persistence boundaries (ticket #56 EVENTS.md
 * "Event ids and timestamps come from injected ports", mirroring `Clock`).
 */
export interface IdGenerator {
  next(): string;
}

/** Production adapter; tests inject a deterministic sequence. */
export class SystemIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
