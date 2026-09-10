import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";

describe("connection Local API", () => {
  const engines: Harness[] = [];
  const roots: string[] = [];
  const servers: Server[] = [];
  const validateDescriptor = localApiValidator("ResourceDescriptor");

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function start(options: Parameters<typeof startEngine>[0] = {}): Promise<Harness> {
    const engine = await startEngine(options);
    engines.push(engine);
    return engine;
  }

  it("registers, upserts, lists and restores descriptors without the secret", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-connections-api-"));
    roots.push(dataRoot);
    const engine = await start({ dataRoot });
    const secretRef = "gh://Gasppacho";
    const first = await engine.call("/v1/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "connection/github-main",
        kind: "github",
        displayName: "Gasppacho",
        secretRef,
      }),
    });

    expect(first.status).toBe(201);
    const descriptor = (await first.json()) as Record<string, unknown>;
    expect(validateDescriptor(descriptor), explain(validateDescriptor)).toBe(true);
    expect(descriptor).toEqual({
      id: "connection/github-main",
      kind: "github",
      displayName: "Gasppacho",
      status: "unauthenticated",
      capabilities: ["github.api", "scm.change-request.manage", "work-items.read"],
    });
    expect(JSON.stringify(descriptor)).not.toContain(secretRef);

    const updated = await engine.call("/v1/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "connection/github-main",
        kind: "github",
        displayName: "Gasppacho updated",
        secretRef: "gh://Gasppacho-updated",
      }),
    });
    expect(updated.status).toBe(201);

    const list = await engine.call("/v1/connections");
    expect(list.status).toBe(200);
    expect((await list.json()) as unknown).toEqual({
      items: [
        {
          id: "connection/github-main",
          kind: "github",
          displayName: "Gasppacho updated",
          status: "unauthenticated",
          capabilities: ["github.api", "scm.change-request.manage", "work-items.read"],
        },
      ],
    });

    await engine.dispose();
    engines.splice(engines.indexOf(engine), 1);
    const restored = await start({ dataRoot });
    const restoredList = await restored.call("/v1/connections");
    expect(restoredList.status).toBe(200);
    expect((await restoredList.json()) as unknown).toMatchObject({
      items: [
        expect.objectContaining({ id: "connection/github-main", displayName: "Gasppacho updated" }),
      ],
    });
  });

  it("rejects unknown properties, credentials and unsupported providers without echoing secrets", async () => {
    const engine = await start();
    const request = (body: unknown) =>
      engine.call("/v1/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const unknown = await request({
      id: "connection/unknown",
      kind: "github",
      displayName: "Unknown",
      secretRef: "gh://unknown",
      unexpected: "value",
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()) as unknown).toMatchObject({
      error: { code: "api.invalid-request" },
    });

    const secret = "ghs_connection_secret_sentinel";
    const credential = await request({
      id: "connection/secret",
      kind: "github",
      displayName: "Secret",
      secretRef: secret,
    });
    expect(credential.status).toBe(400);
    const credentialBody = JSON.stringify(await credential.json());
    expect(credentialBody).toContain("connection.secret-ref-invalid");
    expect(credentialBody).not.toContain(secret);
    expect(engine.stderr()).not.toContain(secret);

    const unsupported = await request({
      id: "connection/gitlab",
      kind: "gitlab",
      displayName: "GitLab",
      secretRef: "gh://gitlab",
    });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()) as unknown).toMatchObject({
      error: { code: "connection.provider-unsupported" },
    });
  });

  it("keeps bearer, loopback and degraded-database protections", async () => {
    const engine = await start();
    expect((await engine.callUnauthenticated("/v1/connections")).status).toBe(401);
    expect(
      (
        await engine.callRaw("/v1/connections", {
          host: "jarvis.example.com",
          authorization: `Bearer ${engine.token}`,
        })
      ).status,
    ).toBe(403);

    const blocked = mkdtempSync(join(tmpdir(), "jarvis-connections-blocked-"));
    roots.push(blocked);
    const occupied = join(blocked, "occupied");
    writeFileSync(occupied, "not a directory", "utf8");
    const degraded = await start({ dataRoot: join(occupied, "data") });
    for (const [path, method] of [["/v1/connections", "GET"]] as const) {
      const response = await degraded.call(path, { method });
      expect(response.status).toBe(503);
      expect((await response.json()) as unknown).toMatchObject({
        error: { code: "engine.database-unavailable" },
      });
    }

    const post = await degraded.call("/v1/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "connection/degraded",
        kind: "github",
        displayName: "Degraded",
        secretRef: "gh://degraded",
      }),
    });
    expect(post.status).toBe(503);
    expect((await post.json()) as unknown).toMatchObject({
      error: { code: "engine.database-unavailable" },
    });
  });

  it("validates a registered GitHub connection, persists the refreshed descriptor and is retry-safe", async () => {
    const credential = "ghs_validation_sentinel";
    const fakeGhRoot = mkdtempSync(join(tmpdir(), "jarvis-gh-validation-"));
    roots.push(fakeGhRoot);
    const fakeGh = join(fakeGhRoot, "gh");
    writeFileSync(fakeGh, `#!/bin/sh\nprintf '%s\\n' '${credential}'\n`, "utf8");
    chmodSync(fakeGh, 0o755);

    const requests: { method: string; path: string; authorized: boolean }[] = [];
    const github = createServer((request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorized: request.headers.authorization === `Bearer ${credential}`,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ login: "github-login" }));
    });
    servers.push(github);
    const apiBaseUrl = await listen(github);
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-connections-validation-"));
    roots.push(dataRoot);
    const options = {
      dataRoot,
      env: { JARVIS_GH_EXECUTABLE: fakeGh, JARVIS_GITHUB_API_BASE_URL: apiBaseUrl },
    };
    const engine = await start(options);
    const registered = await register(engine, "connection/github-validation");
    expect(registered.status).toBe(201);

    const first = await engine.call("/v1/connections/connection%2Fgithub-validation/validate", {
      method: "POST",
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(validateDescriptor(firstBody), explain(validateDescriptor)).toBe(true);
    expect(firstBody).toEqual({
      id: "connection/github-validation",
      kind: "github",
      displayName: "github-login",
      status: "available",
      capabilities: ["github.api", "scm.change-request.manage", "work-items.read"],
    });
    expect(JSON.stringify(firstBody)).not.toContain(credential);

    const second = await engine.call("/v1/connections/connection%2Fgithub-validation/validate", {
      method: "POST",
    });
    expect(second.status).toBe(200);
    expect((await second.json()) as unknown).toEqual(firstBody);
    expect(requests).toEqual([
      { method: "GET", path: "/user", authorized: true },
      { method: "GET", path: "/user", authorized: true },
    ]);
    expect((await (await engine.call("/v1/connections")).json()) as unknown).toEqual({
      items: [firstBody],
    });
    expect(engine.stderr()).not.toContain(credential);

    await engine.dispose();
    engines.splice(engines.indexOf(engine), 1);
    const restarted = await start(options);
    const restored = await restarted.call("/v1/connections");
    expect((await restored.json()) as unknown).toEqual({ items: [firstBody] });
  });

  it("keeps a rejected connection registered and reports unknown validation ids", async () => {
    const fakeGhRoot = mkdtempSync(join(tmpdir(), "jarvis-gh-rejected-"));
    roots.push(fakeGhRoot);
    const fakeGh = join(fakeGhRoot, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\nprintf '%s\\n' 'ghs_rejected_sentinel'\n", "utf8");
    chmodSync(fakeGh, 0o755);
    const github = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Bad credentials" }));
    });
    servers.push(github);
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-connections-rejected-"));
    roots.push(dataRoot);
    const engine = await start({
      dataRoot,
      env: {
        JARVIS_GH_EXECUTABLE: fakeGh,
        JARVIS_GITHUB_API_BASE_URL: await listen(github),
      },
    });
    await register(engine, "connection/github-rejected");

    const rejected = await engine.call("/v1/connections/connection%2Fgithub-rejected/validate", {
      method: "POST",
    });
    expect(rejected.status).toBe(200);
    expect((await rejected.json()) as unknown).toMatchObject({
      id: "connection/github-rejected",
      status: "unauthenticated",
      capabilities: [],
    });
    expect((await (await engine.call("/v1/connections")).json()) as unknown).toMatchObject({
      items: [
        expect.objectContaining({ id: "connection/github-rejected", status: "unauthenticated" }),
      ],
    });

    const unknown = await engine.call("/v1/connections/connection%2Fmissing/validate", {
      method: "POST",
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()) as unknown).toMatchObject({
      error: { code: "connection.not-found" },
    });
  });

  async function register(engine: Harness, id: string): Promise<Response> {
    return engine.call("/v1/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        kind: "github",
        displayName: "Registered account",
        secretRef: "gh://Gasppacho",
      }),
    });
  }

  function listen(server: Server): Promise<string> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("fake GitHub server did not expose a port"));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }
});
