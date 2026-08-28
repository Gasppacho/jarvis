import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const withToken = { JARVIS_API_TOKEN: "session-token" } satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("refuses to start without a session token", () => {
    // LOCAL_DEVELOPMENT.md: no unauthenticated mode exists, not even in development.
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ JARVIS_API_TOKEN: "" })).toThrow(ConfigError);
  });

  it("explains how to recover when the token is missing", () => {
    try {
      loadConfig({});
      expect.unreachable("loadConfig should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).remedy).not.toHaveLength(0);
    }
  });

  it("puts the database inside JARVIS_DATA_ROOT under the name PERSISTENCE.md gives it", () => {
    const config = loadConfig({ ...withToken, JARVIS_DATA_ROOT: "/tmp/jarvis-test" });

    expect(config.dataRoot).toBe("/tmp/jarvis-test");
    expect(config.databasePath).toBe("/tmp/jarvis-test/jarvis.sqlite");
  });

  it("falls back to Application Support when no data root is given", () => {
    const config = loadConfig(withToken);

    expect(config.databasePath).toMatch(/Library\/Application Support\/Jarvis\/jarvis\.sqlite$/);
  });

  it("binds loopback and asks the OS for a free port by default", () => {
    const config = loadConfig(withToken);

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(0);
  });

  it("mints a session id when the shell does not supply one", () => {
    expect(loadConfig(withToken).sessionId).not.toBe(loadConfig(withToken).sessionId);
    expect(loadConfig({ ...withToken, JARVIS_SESSION_ID: "s-1" }).sessionId).toBe("s-1");
  });

  it("rejects a port that is not a valid TCP port", () => {
    expect(() => loadConfig({ ...withToken, JARVIS_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...withToken, JARVIS_PORT: "not-a-port" })).toThrow(ConfigError);
  });

  it("rejects a port that only Number() would find plausible", () => {
    // Number("") is 0 and Number("0x1f") is 31: both would silently bind
    // something other than what the caller asked for.
    for (const port of ["", " ", "1e3", "0x1f", "-1", "8080 ", "80.5"]) {
      expect(() => loadConfig({ ...withToken, JARVIS_PORT: port })).toThrow(ConfigError);
    }
  });
});
