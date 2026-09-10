import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubApiClient, GitHubApiError } from "./api-client.js";

describe("GitHubApiClient", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("resolves the credential separately for every request and scopes calls to the API host", async () => {
    let resolutions = 0;
    const requests: { method: string; path: string; authorized: boolean }[] = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorized: request.headers.authorization === "Bearer gh_client_sentinel",
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const client = new GitHubApiClient({
      secretRef: "gh://Gasppacho",
      apiBaseUrl: baseUrl,
      credentialResolver: {
        resolve: async () => {
          resolutions += 1;
          return { status: "available", credential: "gh_client_sentinel" };
        },
      },
    });

    await expect(client.get("/user")).resolves.toEqual({ status: 200, body: { ok: true } });
    await expect(client.request({ method: "GET", path: "/user?owned=true" })).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(resolutions).toBe(2);
    expect(requests).toEqual([
      { method: "GET", path: "/user", authorized: true },
      { method: "GET", path: "/user?owned=true", authorized: true },
    ]);
  });

  it("does not call the network when the credential is unavailable and does not expose it", async () => {
    let requests = 0;
    const client = new GitHubApiClient({
      secretRef: "gh://Gasppacho",
      apiBaseUrl: "http://127.0.0.1:1",
      credentialResolver: { resolve: async () => ({ status: "unauthenticated" }) },
    });

    await expect(client.get("/user")).rejects.toEqual(new GitHubApiError("unauthenticated"));
    expect(requests).toBe(0);
    expect(JSON.stringify(new GitHubApiError("unavailable"))).not.toContain("gh_");
  });

  it("returns only rate-limit response headers needed for classification", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, {
        "content-type": "application/json",
        "retry-after": "30",
        "x-ratelimit-remaining": "0",
        "x-provider-secret": "must-not-cross-the-client-boundary",
      });
      response.end(JSON.stringify({ message: "rate limited" }));
    });
    servers.push(server);
    const client = new GitHubApiClient({
      secretRef: "gh://Gasppacho",
      apiBaseUrl: await listen(server),
      credentialResolver: {
        resolve: async () => ({ status: "available", credential: "gh_client_sentinel" }),
      },
    });

    await expect(client.get("/user")).resolves.toEqual({
      status: 403,
      body: { message: "rate limited" },
      headers: { "retry-after": "30", "x-ratelimit-remaining": "0" },
    });
  });

  it("rejects absolute URLs so a bound client cannot escape its API host", async () => {
    const client = new GitHubApiClient({
      secretRef: "gh://Gasppacho",
      credentialResolver: { resolve: async () => ({ status: "available", credential: "secret" }) },
    });
    await expect(client.get("https://example.invalid/user")).rejects.toThrow("absolute paths");
  });
});

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
