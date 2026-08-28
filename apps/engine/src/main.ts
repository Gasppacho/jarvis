import { ConfigurationError, LOOPBACK_HOST, loadConfig } from "./config.ts";
import { openDatabase } from "./db/open.ts";
import { createServer, type HealthResponse } from "./http/server.ts";
import { ProjectService } from "./projects/service.ts";
import { ProjectStore } from "./projects/store.ts";
import { API_VERSION, ENGINE_VERSION } from "./version.ts";

/**
 * Startup protocol, docs/architecture/SYSTEM.md:
 * bind loopback on a dynamic port, migrate, then announce readiness with a
 * single JSON line on stdout.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const database = openDatabase(config.dataRoot);

  if (database.status === "failed") {
    process.stderr.write(
      `database unavailable: ${database.failure ?? "unknown error"}\n`,
    );
  }

  let shuttingDown = false;
  const health = (): HealthResponse => ({
    status: shuttingDown
      ? "shutting-down"
      : database.status === "ready"
        ? "ready"
        : "degraded",
    engineVersion: ENGINE_VERSION,
    apiVersion: API_VERSION,
    database: database.status,
  });

  // A failed database degrades the engine; it does not kill it. The shell needs
  // a reachable /v1/health to explain what is wrong (MVP_SPEC user story 3).
  const projects =
    database.db === null
      ? null
      : new ProjectService(new ProjectStore(database.db));

  const app = createServer({
    token: config.token,
    health,
    projects,
    onShutdownRequested: () => void shutdown(0),
    ...(process.env.JARVIS_LOG_LEVEL === undefined
      ? {}
      : { logLevel: process.env.JARVIS_LOG_LEVEL }),
  });

  let closing = false;
  async function shutdown(code: number): Promise<void> {
    if (closing) return;
    closing = true;
    shuttingDown = true;
    try {
      await app.close();
    } catch (error) {
      process.stderr.write(`shutdown error: ${String(error)}\n`);
    }
    database.close();
    process.exit(code);
  }

  await app.listen({ host: LOOPBACK_HOST, port: config.port });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the engine did not obtain a TCP port");
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(0));
  }
  // The shell holds this pipe open for the Engine Session. EOF means the
  // supervisor is gone, so the engine must not survive as an orphan.
  process.stdin.resume();
  process.stdin.once("end", () => void shutdown(0));

  process.stdout.write(
    `${JSON.stringify({
      type: "ready",
      port: address.port,
      apiVersion: API_VERSION,
      sessionId: config.sessionId,
    })}\n`,
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`engine failed to start: ${String(error)}\n`);
  process.exit(1);
}
