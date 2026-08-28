import { describe, expect, it } from "vitest";
import { ConfigurationError, loadConfig } from "./config.ts";

const token = "0".repeat(43);

describe("loadConfig", () => {
  it("refuses to start without a session token", () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
    expect(() => loadConfig({})).toThrow(/JARVIS_TOKEN is missing/);
  });

  it("refuses a token weaker than the shell is expected to generate", () => {
    expect(() => loadConfig({ JARVIS_TOKEN: "short" })).toThrow(/too short/);
  });

  it("defaults to a dynamic port so two engines never fight over one", () => {
    expect(loadConfig({ JARVIS_TOKEN: token }).port).toBe(0);
  });

  it("rejects a port that is not a valid TCP port", () => {
    for (const bad of ["-1", "65536", "http", "1.5"]) {
      expect(() =>
        loadConfig({ JARVIS_TOKEN: token, JARVIS_PORT: bad }),
      ).toThrow(ConfigurationError);
    }
    expect(loadConfig({ JARVIS_TOKEN: token, JARVIS_PORT: "43127" }).port).toBe(
      43127,
    );
  });

  it("honours an isolated data root and generates a session id when absent", () => {
    const config = loadConfig({
      JARVIS_TOKEN: token,
      JARVIS_DATA_ROOT: "/tmp/jarvis-test",
    });
    expect(config.dataRoot).toBe("/tmp/jarvis-test");
    expect(config.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the session id chosen by the shell", () => {
    expect(
      loadConfig({ JARVIS_TOKEN: token, JARVIS_SESSION_ID: "session-1" })
        .sessionId,
    ).toBe("session-1");
  });

  it("falls back to Application Support when no data root is given", () => {
    expect(loadConfig({ JARVIS_TOKEN: token }).dataRoot).toMatch(
      /Library\/Application Support\/Jarvis$/,
    );
  });
});
