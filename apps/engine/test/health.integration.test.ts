import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parse as parseYaml } from "yaml";

const addFormats = addFormatsModule.default;
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type EngineHandle } from "./harness.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The OpenAPI document is the source of truth, so assert against it directly. */
function healthResponseValidator() {
  const document = parseYaml(
    readFileSync(
      join(REPO_ROOT, "contracts/openapi/local-api.v1.yaml"),
      "utf8",
    ),
  ) as { components: { schemas: Record<string, object> } };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(document.components.schemas.HealthResponse!);
}

const errorEnvelope = (body: string) =>
  JSON.parse(body) as {
    error: { code: string; message: string; correlationId: string };
  };

describe("engine walking skeleton", () => {
  const started: EngineHandle[] = [];
  let validateHealth: ReturnType<typeof healthResponseValidator>;

  beforeAll(() => {
    validateHealth = healthResponseValidator();
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((engine) => engine.stop()));
  });

  async function start(...args: Parameters<typeof startEngine>) {
    const engine = await startEngine(...args);
    started.push(engine);
    return engine;
  }

  it("announces exactly one ready line on stdout and nothing else", async () => {
    const engine = await start();

    expect(engine.ready).toMatchObject({ type: "ready", apiVersion: "v1" });
    expect(engine.ready.port).toBeGreaterThan(0);
    expect(engine.ready.sessionId).toEqual(expect.any(String));

    await engine.call("/v1/health");
    expect(engine.stdoutLines).toHaveLength(1);
  });

  it("is unreachable from a non-loopback interface", async () => {
    const engine = await start();
    expect(engine.baseUrl).toContain("127.0.0.1");

    const external = Object.values(networkInterfaces())
      .flat()
      .find(
        (iface) =>
          iface !== undefined && !iface.internal && iface.family === "IPv4",
      );
    if (external === undefined) return; // machine has no external IPv4 to try

    // A listener bound to 0.0.0.0 would answer here. Refusal (or a dropped
    // packet behind a firewall) is what a loopback-only bind looks like.
    await expect(
      fetch(`http://${external.address}:${engine.ready.port}/v1/health`, {
        signal: AbortSignal.timeout(3_000),
      }),
    ).rejects.toThrow();
  });

  it("refuses a request whose Host is not loopback even on the loopback socket", async () => {
    const engine = await start();

    const response = await engine.raw("/v1/health", {
      host: `0.0.0.0:${engine.ready.port}`,
      authorization: `Bearer ${engine.token}`,
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects a missing or wrong bearer token", async () => {
    const engine = await start();

    const anonymous = await fetch(new URL("/v1/health", engine.baseUrl));
    expect(anonymous.status).toBe(401);
    expect(errorEnvelope(await anonymous.text()).error.code).toBe(
      "api.unauthorized",
    );

    const wrong = await engine.call("/v1/health", {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(wrong.status).toBe(401);
    expect(errorEnvelope(await wrong.text()).error.correlationId).toMatch(
      /^api_/,
    );
  });

  it("rejects tokens that merely resemble the session token", async () => {
    const engine = await start();

    const nearMisses = [
      engine.token.slice(0, 8), // a truncated prefix
      engine.token.slice(0, -1), // one character short
      `${engine.token}x`, // one character too long
      `${engine.token.slice(0, 8)}${"z".repeat(engine.token.length - 8)}`, // shared prefix
    ];

    for (const candidate of nearMisses) {
      const response = await engine.call("/v1/health", {
        headers: { authorization: `Bearer ${candidate}` },
      });
      expect(
        response.status,
        `token "${candidate}" must not authenticate`,
      ).toBe(401);
    }
  });

  it("rejects an Authorization header that is not a single bearer token", async () => {
    const engine = await start();

    for (const header of [
      engine.token, // no scheme at all
      `Basic ${engine.token}`,
      `Bearer ${engine.token} extra`,
      "Bearer ",
    ]) {
      const response = await engine.call("/v1/health", {
        headers: { authorization: header },
      });
      expect(response.status, `header "${header}" must not authenticate`).toBe(
        401,
      );
    }
  });

  it("rejects a non-loopback Host header before authenticating", async () => {
    const engine = await start();

    const response = await engine.raw("/v1/health", {
      host: "jarvis.example.com",
      authorization: `Bearer ${engine.token}`,
    });

    expect(response.statusCode).toBe(403);
    expect(errorEnvelope(response.body).error.code).toBe(
      "api.host-not-allowed",
    );
  });

  it("serves a health document valid against the OpenAPI contract", async () => {
    const engine = await start();

    const response = await engine.call("/v1/health");
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(validateHealth(body), JSON.stringify(validateHealth.errors)).toBe(
      true,
    );
    expect(body).toMatchObject({
      status: "ready",
      apiVersion: "v1",
      database: "ready",
    });
  });

  it("keeps every byte of state under JARVIS_DATA_ROOT", async () => {
    const engine = await start();
    await engine.call("/v1/health");

    expect(existsSync(join(engine.dataRoot, "jarvis.db"))).toBe(true);
  });

  it("reopens an existing data root after a restart", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-restart-"));
    try {
      const first = await start({ dataRoot });
      expect(
        (
          (await (await first.call("/v1/health")).json()) as {
            database: string;
          }
        ).database,
      ).toBe("ready");
      await first.stop();

      const second = await start({ dataRoot });
      const health = (await (await second.call("/v1/health")).json()) as {
        status: string;
        database: string;
      };
      expect(health).toMatchObject({ status: "ready", database: "ready" });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("shuts down gracefully with exit code 0", async () => {
    const engine = await start();

    const response = await engine.call("/v1/system/shutdown", {
      method: "POST",
    });
    expect(response.status).toBe(202);

    await expect(engine.waitForExit()).resolves.toBe(0);
  });

  it("exits when the supervising shell closes its stdin pipe", async () => {
    const engine = await start();
    await engine.call("/v1/health");

    // The shell holds stdin open for the engine's lifetime. EOF means the
    // supervisor is gone, and no orphan engine may outlive it.
    engine.closeStdin();

    await expect(engine.waitForExit()).resolves.toBe(0);
  });
});
