import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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

/**
 * `homeDirectory` is injected because `homedir()` reads the process environment
 * rather than `env`, which would make the set-but-empty HOME case untestable.
 * coding-standards.md asks for filesystem access behind a testable port.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  homeDirectory: () => string = homedir,
): EngineConfig {
  const apiToken = env["JARVIS_API_TOKEN"];
  if (apiToken === undefined || apiToken.length === 0) {
    // LOCAL_DEVELOPMENT.md forbids an unauthenticated mode, in development too.
    throw new ConfigError(
      "JARVIS_API_TOKEN is missing.",
      "The macOS shell mints a session token and passes it to the engine. Start Jarvis.app rather than the engine alone.",
    );
  }

  const dataRoot = parseDataRoot(env["JARVIS_DATA_ROOT"], homeDirectory);

  return {
    dataRoot,
    databasePath: join(dataRoot, "jarvis.sqlite"),
    apiToken,
    // Empty is what `${JARVIS_SESSION_ID:-}` expands to, and an empty session id
    // would leave the shell correlating against nothing.
    sessionId: emptyToUndefined(env["JARVIS_SESSION_ID"]) ?? randomUUID(),
    host: LOOPBACK_HOST,
    port: parsePort(env["JARVIS_PORT"]),
  };
}

function parseDataRoot(raw: string | undefined, homeDirectory: () => string): string {
  // Empty is what a launcher's `${JARVIS_DATA_ROOT:-}` expands to. Treating it
  // as a path makes `dirname` yield ".", which would adopt — and re-permission
  // — whatever directory the engine happens to be started from.
  const supplied = emptyToUndefined(raw);

  // The default is checked too: homedir() returns HOME verbatim, so a
  // set-but-empty HOME — plausible under launchd — makes this relative.
  const home = homeDirectory();
  const candidate = supplied ?? join(home, "Library", "Application Support", "Jarvis");
  if (!isAbsolute(candidate)) {
    throw new ConfigError(
      supplied === undefined
        ? `Cannot locate Application Support: HOME is not an absolute path (got ${JSON.stringify(home)}).`
        : `JARVIS_DATA_ROOT must be an absolute path, got ${JSON.stringify(supplied)}.`,
      "A relative path would resolve against whatever directory the engine was started from.",
    );
  }

  // Normalised here so `dataRoot` and `databasePath` cannot disagree: `join`
  // already normalises the latter.
  return resolve(candidate);
}

function emptyToUndefined(raw: string | undefined): string | undefined {
  return raw === undefined || raw === "" ? undefined : raw;
}

function parsePort(raw: string | undefined): number {
  // `JARVIS_PORT=${PORT:-}` in a launcher expands to the empty string; that is
  // still "no preference", not a malformed port.
  const supplied = emptyToUndefined(raw);
  if (supplied === undefined) return 0;
  // Number() would turn " ", "1e3" and "0x1f" into plausible-looking ports, so
  // a malformed value has to be rejected before conversion.
  const port = /^\d+$/.test(supplied) ? Number(supplied) : Number.NaN;
  if (!Number.isInteger(port) || port > 65_535) {
    throw new ConfigError(
      `JARVIS_PORT is not a valid port: ${JSON.stringify(supplied)}`,
      "Unset it to pick a free port.",
    );
  }
  return port;
}
