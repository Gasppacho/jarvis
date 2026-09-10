import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubCliCredentialResolver } from "./credentials.js";
import { GitHubProviderCheckAdapter } from "./provider-check.js";

const CREDENTIAL = "ghs_provider_check_sentinel";

interface RequestRecord {
  readonly method: string;
  readonly path: string;
  readonly hasAuthorization: boolean;
}

interface FakeGitHub {
  readonly url: string;
  readonly requests: RequestRecord[];
  close(): Promise<void>;
}

describe("GitHubProviderCheckAdapter", () => {
  const roots: string[] = [];
  const servers: FakeGitHub[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("authenticates with gh, sends one GET /user, and returns the reported login and capabilities", async () => {
    const server = await fakeGitHub((request, response) => {
      const authorized = request.headers.authorization === `Bearer ${CREDENTIAL}`;
      response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
      response.end(
        JSON.stringify(authorized ? { login: "Gasppacho" } : { message: "Bad credentials" }),
      );
    });
    const adapter = adapterFor(server.url, fakeGh());

    await expect(adapter.check("gh://Gasppacho")).resolves.toEqual({
      status: "available",
      accountLabel: "Gasppacho",
      capabilities: ["github.api", "scm.change-request.manage", "work-items.read"],
    });
    expect(server.requests).toEqual([{ method: "GET", path: "/user", hasAuthorization: true }]);
  });

  it.each([
    [401, { message: "Bad credentials" }, "unauthenticated"],
    [401, { message: "Token has been revoked" }, "revoked"],
    [500, { message: "provider failure" }, "unavailable"],
  ] as const)("classifies HTTP %s without issuing a mutation", async (status, body, expected) => {
    const server = await fakeGitHub((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    const result = await adapterFor(server.url, fakeGh()).check("gh://Gasppacho");

    expect(result).toEqual({ status: expected });
    expect(server.requests).toEqual([{ method: "GET", path: "/user", hasAuthorization: true }]);
  });

  it("classifies a non-JSON response instead of throwing", async () => {
    const server = await fakeGitHub((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("not json");
    });

    await expect(adapterFor(server.url, fakeGh()).check("gh://Gasppacho")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("maps a missing gh executable to unavailable without making an HTTP request", async () => {
    const server = await fakeGitHub((_request, response) => response.end());
    const missing = join(mkdtempSync(join("/tmp", "jarvis-gh-missing-")), "gh");
    roots.push(missing.slice(0, missing.lastIndexOf("/")));

    await expect(adapterFor(server.url, missing).check("gh://Gasppacho")).resolves.toEqual({
      status: "unavailable",
    });
    expect(server.requests).toEqual([]);
  });

  it("maps a network failure to unavailable", async () => {
    const server = await fakeGitHub((_request, response) => response.end());
    const url = server.url;
    await server.close();

    await expect(adapterFor(url, fakeGh()).check("gh://Gasppacho")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("bounds a server that never answers", async () => {
    const server = await fakeGitHub(() => undefined);
    const startedAt = Date.now();

    await expect(
      adapterFor(server.url, fakeGh(), { timeoutMs: 20 }).check("gh://Gasppacho"),
    ).resolves.toEqual({ status: "unavailable" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(server.requests).toEqual([{ method: "GET", path: "/user", hasAuthorization: true }]);
  });

  function fakeGh(): string {
    const root = mkdtempSync(join("/tmp", "jarvis-gh-"));
    roots.push(root);
    const path = join(root, "gh");
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${CREDENTIAL}'\n`, "utf8");
    chmodSync(path, 0o755);
    return path;
  }

  function adapterFor(
    apiBaseUrl: string,
    executable: string,
    options: { readonly timeoutMs?: number } = {},
  ): GitHubProviderCheckAdapter {
    return new GitHubProviderCheckAdapter({
      apiBaseUrl,
      credentialResolver: new GitHubCliCredentialResolver({
        cwd: process.cwd(),
        knownExecutablePaths: [executable],
        allowShellProbe: false,
      }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  async function fakeGitHub(
    handler: (
      request: import("node:http").IncomingMessage,
      response: import("node:http").ServerResponse,
    ) => void,
  ): Promise<FakeGitHub> {
    const requests: RequestRecord[] = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        hasAuthorization: typeof request.headers.authorization === "string",
      });
      handler(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Fake GitHub server did not expose a TCP address.");
    }

    const fake: FakeGitHub = {
      url: `http://127.0.0.1:${address.port}`,
      requests,
      close: () => closeServer(server),
    };
    servers.push(fake);
    return fake;
  }
});

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
