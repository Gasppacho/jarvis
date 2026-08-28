import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EngineConfig {
  /** Every file the engine writes lives under this root. */
  readonly dataRoot: string;
  readonly databasePath: string;
  /** Session bearer token minted by the macOS shell. */
  readonly apiToken: string;
  readonly sessionId: string;
  readonly host: string;
  /** 0 asks the OS for a free port; the handshake reports the real one. */
  readonly port: number;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOOPBACK_HOST = "127.0.0.1";

export function loadConfig(env: NodeJS.ProcessEnv): EngineConfig {
  const apiToken = env["JARVIS_API_TOKEN"];
  if (apiToken === undefined || apiToken.length === 0) {
    // LOCAL_DEVELOPMENT.md forbids an unauthenticated mode, in development too.
    throw new ConfigError(
      "JARVIS_API_TOKEN is missing.",
      "The macOS shell mints a session token and passes it to the engine. Start Jarvis.app rather than the engine alone.",
    );
  }

  const dataRoot =
    env["JARVIS_DATA_ROOT"] ?? join(homedir(), "Library", "Application Support", "Jarvis");

  return {
    dataRoot,
    databasePath: join(dataRoot, "jarvis.sqlite"),
    apiToken,
    sessionId: env["JARVIS_SESSION_ID"] ?? randomUUID(),
    host: LOOPBACK_HOST,
    port: parsePort(env["JARVIS_PORT"]),
  };
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 0;
  // Number() would turn "", " ", "1e3" and "0x1f" into plausible-looking ports,
  // so a malformed value has to be rejected before conversion.
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port > 65_535) {
    throw new ConfigError(
      `JARVIS_PORT is not a valid port: ${JSON.stringify(raw)}`,
      "Unset it to pick a free port.",
    );
  }
  return port;
}
