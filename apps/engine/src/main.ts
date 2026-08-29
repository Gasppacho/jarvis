import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase, type OpenedDatabase } from "./db/open.js";
import { buildServer } from "./http/server.js";
import { API_VERSION } from "./version.js";

const SHUTDOWN_GRACE_MS = 5_000;

async function main(): Promise<void> {
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
      process.stderr.write(`jarvis-engine: could not close the database.\n${String(error)}\n`);
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
      process.stderr.write("jarvis-engine: shutdown timed out; forcing exit.\n");
      closeDatabase();
      process.exit(exitCode === 0 ? 1 : exitCode);
    }, SHUTDOWN_GRACE_MS);

    let code = exitCode;
    try {
      if (app !== undefined) await app.close();
    } catch (error) {
      process.stderr.write(`jarvis-engine: shutdown failed.\n${String(error)}\n`);
      code = 1;
    } finally {
      // Closing the handle is what checkpoints the WAL, so its failure is the
      // one that must not be reported as a clean shutdown.
      if (!closeDatabase()) code = 1;
      process.exit(code);
    }
  }

  // Registered before the database is even opened: migrations are the longest
  // and most write-heavy part of startup, and leaving them under the default
  // signal disposition is exactly the "bail without closing" case this exists
  // to prevent. Exits non-zero until the handshake is out, so the shell never
  // reads a clean exit from an engine that never became ready.
  const onSignal = (): void => void shutdown(announced ? 0 : 1);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

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
    process.stderr.write(`jarvis-engine: ${error.message}\n${error.remedy}\n`);
  } else {
    process.stderr.write(`jarvis-engine: failed to start.\n${String(error)}\n`);
  }
  process.exit(1);
});
