/**
 * Exits when the process that launched the engine goes away.
 *
 * MACOS_APP.md: "un crash du shell ne doit pas laisser plusieurs moteurs
 * concurrents : lockfile/session et parent-process monitoring". The shell's
 * graceful path is POST /v1/system/shutdown; this covers the paths where the
 * shell never gets to ask — a crash, a SIGKILL, a force quit.
 */
const POLL_INTERVAL_MS = 1_000;

export interface ParentWatchOptions {
  readonly onOrphaned: () => void;
  readonly intervalMs?: number;
  /** Injected for the test seam; defaults to this process's real parent. */
  readonly initialParentPid?: number;
  readonly currentParentPid?: () => number;
}

export function watchParentProcess(options: ParentWatchOptions): () => void {
  const readParent = options.currentParentPid ?? (() => process.ppid);
  const initial = options.initialParentPid ?? readParent();

  // Already orphaned at startup (ppid 1 means launchd adopted us), so there is
  // no parent whose death could be detected. Nothing to watch.
  if (initial <= 1) return () => {};

  const timer = setInterval(() => {
    if (readParent() !== initial) options.onOrphaned();
  }, options.intervalMs ?? POLL_INTERVAL_MS);
  // Never hold the event loop open on the engine's account.
  timer.unref();

  return () => clearInterval(timer);
}
