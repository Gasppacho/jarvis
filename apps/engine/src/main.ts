import { writeSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase, type OpenedDatabase } from "./db/open.js";
import { buildServer } from "./http/server.js";
import { watchParentProcess } from "./parent-watch.js";
import { API_VERSION } from "./version.js";

const SHUTDOWN_GRACE_MS = 5_000;
const STDERR_FD = 2;
/**
 * Measured on macOS rather than argued from the docs, because two readings of
 * them disagreed:
 *
 *   - `process.stderr.write` of 200 KB followed by `process.exit` delivers only
 *     65 536 bytes to a pipe. The tail — the part that names the failure — is
 *     lost every time.
 *   - `process.stderr.write` to a closed pipe does not throw; it emits an async
 *     `error`, which without a listener kills the process. That is fatal on the
 *     orphan path, where the shell is gone by definition and the write happens
 *     just before the database is closed.
 *   - `writeSync` delivers all 200 KB before exit, and throws EPIPE
 *     synchronously, which a `try` can actually contain.
 *
 * So: synchronous write, guarded. Never throws — every caller is on its way
 * out, and losing the process before the database closes is worse than losing
 * the message.
 */
function reportFatal(message: string): void {
  try {
    writeSync(STDERR_FD, message);
  } catch {
    /* the shell is gone; there is nobody left to tell */
  }
}

async function main(): Promise<void> {
  // Pino writes to this stream on every request. Once the shell is gone the
  // write fails asynchronously, and an unhandled `error` would take the engine
  // down before it could close the database.
  process.stderr.on("error", () => {});

  const config = loadConfig(process.env);

  let opened: OpenedDatabase | undefined;
  let app: FastifyInstance | undefined;
  let shuttingDown = false;
  let announced = false;

  /** Returns false when the WAL could not be checkpointed. */
  function closeDatabase(): boolean {
    if (opened === undefined) return true;
    try {
      if (opened.db.open) opened.db.close();
      return true;
    } catch (error) {
      reportFatal(`jarvis-engine: could not close the database.\n${String(error)}\n`);
      return false;
    }
  }

  async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    // Deliberately not unref'd: if closing hangs and the remaining handles
    // drain, an unref'd timer would let Node exit 0 without closing the
    // database. The `finally` below always calls process.exit, so this timer
    // can never delay a shutdown that does complete.
    setTimeout(() => {
      reportFatal("jarvis-engine: shutdown timed out; forcing exit.\n");
      closeDatabase();
      process.exit(exitCode === 0 ? 1 : exitCode);
    }, SHUTDOWN_GRACE_MS);

    let code = exitCode;
    try {
      if (app !== undefined) await app.close();
    } catch (error) {
      reportFatal(`jarvis-engine: shutdown failed.\n${String(error)}\n`);
      code = 1;
    } finally {
      // Closing the handle is what checkpoints the WAL, so its failure is the
      // one that must not be reported as a clean shutdown.
      if (!closeDatabase()) code = 1;
      process.exit(code);
    }
  }

  // Registered before the database is opened so no startup phase is ever left
  // under the default signal disposition. openDatabase is synchronous today, so
  // a signal during migrations is queued rather than handled mid-flight; this
  // ordering is what keeps that true if any of it becomes async.
  // Exits non-zero until the handshake is out, so the shell never reads a clean
  // exit from an engine that never became ready.
  const onSignal = (): void => void shutdown(announced ? 0 : 1);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // Registered before the database is opened so that no *asynchronous* phase
  // of startup is left unwatched.
  //
  // ponytail: it cannot fire during migrations themselves — openDatabase is
  // synchronous and blocks the event loop, so a shell that dies mid-migration
  // is noticed only once it returns. Migrations are a single small file today;
  // revisit with an explicit orphan check between steps if they grow.
  watchParentProcess({
    onOrphaned: () => {
      reportFatal("jarvis-engine: the shell went away; shutting down.\n");
      void shutdown(announced ? 0 : 1);
    },
  });

  // SYSTEM.md startup protocol: migrations complete before the ready handshake,
  // so the shell never sees a `ready` engine with an unmigrated database.
  opened = openDatabase(config.databasePath);
  const database = opened;

  app = buildServer({
    config,
    databaseState: database.state,
    isShuttingDown: () => shuttingDown,
    onShutdownRequested: () => {
      void shutdown(0);
    },
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    // The migrations have already run, so bailing here without closing would
    // leave the whole schema in an un-checkpointed WAL.
    closeDatabase();
    throw error;
  }
  const address = app.server.address() as AddressInfo;

  // The one and only stdout line. Everything else the engine says goes to stderr.
  process.stdout.write(
    `${JSON.stringify({
      type: "ready",
      port: address.port,
      apiVersion: API_VERSION,
      sessionId: config.sessionId,
    })}\n`,
  );
  announced = true;
}

main().catch((error: unknown) => {
  // Bootstrap failures must be actionable: the shell surfaces this text verbatim.
  if (error instanceof ConfigError) {
    reportFatal(`jarvis-engine: ${error.message}\n${error.remedy}\n`);
  } else {
    reportFatal(`jarvis-engine: failed to start.\n${String(error)}\n`);
  }
  process.exit(1);
});
