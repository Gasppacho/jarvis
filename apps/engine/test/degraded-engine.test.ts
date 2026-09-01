import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture } from "./repository-fixture.js";

/**
 * A database that cannot be opened degrades the engine rather than killing it:
 * `/v1/health` reports degraded and the project routes answer 503
 * `engine.database-unavailable`, so the shell can explain what is wrong
 * (docs/product/MVP_SPEC.md user story 3).
 */
describe("engine with an unavailable database", () => {
  const started: Harness[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(started.splice(0).map((engine) => engine.dispose()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A data root that cannot be created: the path sits underneath a file. */
  function blockedDataRoot(): string {
    const blocked = mkdtempSync(join(tmpdir(), "jarvis-blocked-"));
    roots.push(blocked);
    const asFile = join(blocked, "occupied");
    writeFileSync(asFile, "a file where the data root must be", "utf8");
    return join(asFile, "data");
  }

  async function startDegraded(): Promise<Harness> {
    const engine = await startEngine({ dataRoot: blockedDataRoot() });
    started.push(engine);
    return engine;
  }

  it("boots, hands out a ready line and reports a degraded health", async () => {
    // The engine must stay reachable so the shell can explain what is wrong.
    const engine = await startDegraded();

    expect(engine.handshake).toMatchObject({ type: "ready" });
    const health = (await (await engine.call("/v1/health")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: "degraded", database: "failed" });
  });

  it("answers every project route with 503 engine.database-unavailable", async () => {
    const engine = await startDegraded();

    const importResponse = await engine.call("/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath: "/some/repo" }),
    });
    expect(importResponse.status).toBe(503);
    expect(((await importResponse.json()) as { error: { code: string } }).error.code).toBe(
      "engine.database-unavailable",
    );

    const listResponse = await engine.call("/v1/projects");
    expect(listResponse.status).toBe(503);
    expect(((await listResponse.json()) as { error: { code: string } }).error.code).toBe(
      "engine.database-unavailable",
    );

    const detailResponse = await engine.call("/v1/projects/some-project");
    expect(detailResponse.status).toBe(503);
    expect(((await detailResponse.json()) as { error: { code: string } }).error.code).toBe(
      "engine.database-unavailable",
    );
  });

  it("keeps discovery working: it inspects the filesystem, not the database", async () => {
    const engine = await startDegraded();
    const root = makeNodeRepositoryFixture({});
    roots.push(root);

    const response = await engine.call("/v1/discovery/repository", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { isGitRepository: boolean }).toMatchObject({
      isGitRepository: true,
    });
  });

  it("still shuts down cleanly from the degraded state", async () => {
    const engine = await startDegraded();

    const response = await engine.call("/v1/system/shutdown", {
      method: "POST",
    });
    expect(response.status).toBe(202);
    await expect(engine.waitForExit()).resolves.toBe(0);
  });
});
