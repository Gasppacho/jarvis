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
    databaseState: () => opened.state,
    onShutdownRequested: () => {
      void shutdown(0);
    },
  });

  async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceExit = setTimeout(() => process.exit(exitCode), SHUTDOWN_GRACE_MS);
    forceExit.unref();
    try {
      await app.close();
      opened.db.close();
    } finally {
      process.exit(exitCode);
    }
  }

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));

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
