import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The engine never binds anything else. docs/architecture/SYSTEM.md:
 * "Le moteur refuse les hosts non-loopback."
 */
export const LOOPBACK_HOST = "127.0.0.1";

/** The shell generates 256 bits; refuse anything obviously weaker. */
const MIN_TOKEN_LENGTH = 32;

export interface EngineConfig {
  readonly token: string;
  readonly sessionId: string;
  readonly dataRoot: string;
  readonly port: number;
}

/** A start-up problem the user can act on, as opposed to a crash. */
export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

function defaultDataRoot(): string {
  return join(homedir(), "Library", "Application Support", "Jarvis");
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigurationError(
      `JARVIS_PORT must be an integer between 0 and 65535, got "${raw}".`,
    );
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv): EngineConfig {
  const token = env.JARVIS_TOKEN?.trim();
  if (!token) {
    throw new ConfigurationError(
      "JARVIS_TOKEN is missing. The macOS shell generates one token per Engine Session and passes it in the child environment.",
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigurationError(
      `JARVIS_TOKEN is too short: expected at least ${MIN_TOKEN_LENGTH} characters.`,
    );
  }

  const dataRoot = env.JARVIS_DATA_ROOT?.trim();

  return {
    token,
    sessionId: env.JARVIS_SESSION_ID?.trim() || randomUUID(),
    dataRoot: dataRoot || defaultDataRoot(),
    port: parsePort(env.JARVIS_PORT),
  };
}
