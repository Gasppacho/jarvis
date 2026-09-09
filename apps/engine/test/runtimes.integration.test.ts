import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";

describe("runtime Local API", () => {
  const started: Harness[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(started.splice(0).map((engine) => engine.dispose()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function start(options: Parameters<typeof startEngine>[0] = {}): Promise<Harness> {
    const engine = await startEngine(options);
    started.push(engine);
    return engine;
  }

  it("lists persisted descriptors without exposing adapter-only fields", async () => {
    const engine = await start();
    const response = await engine.call("/v1/runtimes");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const validate = localApiValidator("ResourceDescriptor");
    expect(body.items).toContainEqual({
      id: "runtime/fake-test",
      kind: "runtime",
      displayName: "Fake Runtime",
      status: "available",
      capabilities: ["agent.execute"],
    });
    for (const item of body.items) {
      expect(validate(item)).toBe(true);
      expect(item).not.toHaveProperty("executablePath");
      expect(item).not.toHaveProperty("version");
      expect(JSON.stringify(item)).not.toContain("/Users/");
    }
  });

  it("discovers supported runtimes, persists the result, and stays idempotent", async () => {
    const engine = await start();

    const firstResponse = await engine.call("/v1/runtimes/discover", { method: "POST" });
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as { items: Array<Record<string, unknown>> };
    expect(first.items).toContainEqual(
      expect.objectContaining({
        id: "runtime/fake-test",
        status: "available",
      }),
    );
    expect(first.items).toContainEqual(
      expect.objectContaining({
        id: "runtime/codex-default",
        status: expect.stringMatching(/^(available|unavailable|unauthenticated|degraded)$/),
      }),
    );

    const secondResponse = await engine.call("/v1/runtimes/discover", { method: "POST" });
    const second = (await secondResponse.json()) as { items: Array<Record<string, unknown>> };
    expect(second.items).toEqual(first.items);
    expect(new Set(second.items.map((item) => item["id"])).size).toBe(second.items.length);
    expect((await (await engine.call("/v1/runtimes")).json()) as unknown).toEqual(second);
  });

  it("keeps authentication, loopback, and database-unavailable behavior", async () => {
    const engine = await start();
    expect((await engine.callUnauthenticated("/v1/runtimes")).status).toBe(401);
    expect(
      (
        await engine.callRaw("/v1/runtimes", {
          host: "jarvis.example.com",
          authorization: `Bearer ${engine.token}`,
        })
      ).status,
    ).toBe(403);

    const blocked = mkdtempSync(join(tmpdir(), "jarvis-runtime-api-blocked-"));
    roots.push(blocked);
    const occupied = join(blocked, "occupied");
    writeFileSync(occupied, "not a directory", "utf8");
    const degraded = await start({ dataRoot: join(occupied, "data") });

    for (const [path, method] of [
      ["/v1/runtimes", "GET"],
      ["/v1/runtimes/discover", "POST"],
    ] as const) {
      const response = await degraded.call(path, { method });
      expect(response.status).toBe(503);
      expect((await response.json()) as { error?: { code?: string } }).toMatchObject({
        error: { code: "engine.database-unavailable" },
      });
    }
  });
});
