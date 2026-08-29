import { describe, expect, it, vi } from "vitest";
import { watchParentProcess } from "./parent-watch.js";

describe("watchParentProcess", () => {
  it("calls back once the parent has gone away", () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    let parent = 4242;

    watchParentProcess({
      onOrphaned,
      intervalMs: 10,
      initialParentPid: 4242,
      currentParentPid: () => parent,
    });

    vi.advanceTimersByTime(30);
    expect(onOrphaned).not.toHaveBeenCalled();

    // The shell died: the engine is reparented to launchd.
    parent = 1;
    vi.advanceTimersByTime(10);
    expect(onOrphaned).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does nothing when the engine was already orphaned at startup", () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();

    watchParentProcess({
      onOrphaned,
      intervalMs: 10,
      initialParentPid: 1,
      currentParentPid: () => 1,
    });

    vi.advanceTimersByTime(100);
    expect(onOrphaned).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reports an orphaned engine only once", () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    let parent = 4242;

    watchParentProcess({
      onOrphaned,
      intervalMs: 10,
      initialParentPid: 4242,
      currentParentPid: () => parent,
    });
    parent = 1;

    vi.advanceTimersByTime(200);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("stops watching once cancelled", () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    let parent = 4242;

    const stop = watchParentProcess({
      onOrphaned,
      intervalMs: 10,
      initialParentPid: 4242,
      currentParentPid: () => parent,
    });
    stop();
    parent = 1;

    vi.advanceTimersByTime(100);
    expect(onOrphaned).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
