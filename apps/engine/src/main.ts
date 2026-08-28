import type { AddressInfo } from "node:net";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db/open.js";
import { buildServer } from "./http/server.js";
import { API_VERSION } from "./version.js";

const SHUTDOWN_GRACE_MS = 5_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  // SYSTEM.md startup protocol: migrations complete before the ready handshake,
  // so the shell never sees a `ready` engine with an unmigrated database.
  const opened = openDatabase(config.databasePath);

  let shuttingDown = false;
  const app = buildServer({
    config,
    databaseState: opened.state,
    isShuttingDown: () => shuttingDown,
    onShutdownRequested: () => {
      void shutdown(0);
    },
  });

  function closeDatabase(): void {
    try {
      if (opened.db.open) opened.db.close();
    } catch (error) {
      process.stderr.write(`jarvis-engine: could not close the database.\n${String(error)}\n`);
    }
  }

  async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    // If closing hangs past the grace period the shutdown did not complete, so
    // the shell must not read it as a clean exit.
    const forceExit = setTimeout(() => {
      process.stderr.write("jarvis-engine: shutdown timed out; forcing exit.\n");
      closeDatabase();
      process.exit(exitCode === 0 ? 1 : exitCode);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    let code = exitCode;
    try {
      await app.close();
    } catch (error) {
      // A failed close leaves the WAL un-checkpointed; reporting 0 would hide it.
      process.stderr.write(`jarvis-engine: shutdown failed.\n${String(error)}\n`);
      code = 1;
    } finally {
      closeDatabase();
      process.exit(code);
    }
  }

  await app.listen({ host: config.host, port: config.port });
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

  // Registered only once the handshake is out. A signal before this point kills
  // the process with a non-zero status, which is what an engine that never
  // became ready should report to the shell.
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
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
