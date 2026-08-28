import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEngine, type Harness } from "./harness.js";

describe("engine walking skeleton", () => {
  let engine: Harness;

  beforeEach(async () => {
    engine = await startEngine();
  });

  afterEach(async () => {
    await engine.dispose();
  });

  describe("startup handshake", () => {
    it("announces readiness with exactly one stdout line", async () => {
      expect(engine.handshake).toMatchObject({
        type: "ready",
        apiVersion: "v1",
      });
      expect(engine.handshake.port).toBeGreaterThan(0);
      expect(engine.handshake.sessionId).not.toHaveLength(0);

      // SYSTEM.md: a single JSON line on stdout, then nothing. Logs go to stderr.
      await engine.call("/v1/health");
      expect(engine.stdoutLines).toHaveLength(1);
    });

    it("keeps its database inside JARVIS_DATA_ROOT", () => {
      // PERSISTENCE.md names the database `jarvis.sqlite`.
      expect(existsSync(join(engine.dataRoot, "jarvis.sqlite"))).toBe(true);
    });
  });

  describe("GET /v1/health", () => {
    it("reports engine, api and database state to an authenticated caller", async () => {
      const response = await engine.call("/v1/health");

      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toEqual({
        status: "ready",
        engineVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
        apiVersion: "v1",
        // Migrations run before the handshake, so the database is never `migrating` here.
        database: "ready",
      });
    });

    it("refuses a caller with no bearer token", async () => {
      const response = await engine.callUnauthenticated("/v1/health");

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error?: Record<string, unknown> };
      expect(body.error).toMatchObject({
        code: expect.any(String),
        message: expect.any(String),
        correlationId: expect.any(String),
      });
    });

    it("refuses a caller with the wrong bearer token", async () => {
      const response = await engine.callUnauthenticated("/v1/health", {
        headers: { authorization: "Bearer not-the-session-token" },
      });

      expect(response.status).toBe(401);
    });

    it("refuses a request that does not address the loopback interface", async () => {
      const response = await engine.callRaw("/v1/health", {
        host: "jarvis.example.com",
        authorization: `Bearer ${engine.token}`,
      });

      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { code: "api.host-not-allowed" },
      });
    });
  });

  describe("POST /v1/system/shutdown", () => {
    it("acknowledges then exits with code 0", async () => {
      const response = await engine.call("/v1/system/shutdown", { method: "POST" });

      expect(response.status).toBe(202);
      await expect(engine.waitForExit()).resolves.toBe(0);
    });

    it("refuses an unauthenticated shutdown", async () => {
      const response = await engine.callUnauthenticated("/v1/system/shutdown", { method: "POST" });

      expect(response.status).toBe(401);
    });
  });
});
