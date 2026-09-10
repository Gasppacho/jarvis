import { afterEach, describe, expect, it } from "vitest";
import { startFakeGitHubApi, type FakeGitHubApi } from "./harness.js";

const servers: FakeGitHubApi[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("fake GitHub API", () => {
  it("records credentials and stores pull requests for head lookup", async () => {
    const github = await startFakeGitHubApi();
    servers.push(github);
    const credential = "ghs_test_sentinel";
    const path = "/repos/Gasppacho/jarvis/pulls";

    const created = await fetch(`${github.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ base: "main", head: "agent/issue-14", draft: true }),
    });

    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody).toMatchObject({
      number: 1,
      html_url: `${github.baseUrl}/repos/Gasppacho/jarvis/pull/1`,
      base: { ref: "main" },
      head: { ref: "agent/issue-14" },
      draft: true,
    });

    const lookupPath = `${path}?head=${encodeURIComponent("agent/issue-14")}`;
    const lookup = await fetch(`${github.baseUrl}${lookupPath}`, {
      headers: { authorization: `Bearer ${credential}` },
    });

    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual([createdBody]);
    const missingLookupPath = `${path}?head=${encodeURIComponent("agent/other")}`;
    const missing = await fetch(`${github.baseUrl}${missingLookupPath}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual([]);
    expect(github.pullRequests).toEqual([
      {
        number: 1,
        htmlUrl: `${github.baseUrl}/repos/Gasppacho/jarvis/pull/1`,
        base: "main",
        head: "agent/issue-14",
        draft: true,
      },
    ]);
    expect(github.requests).toEqual([
      { method: "POST", path, credential },
      { method: "GET", path: lookupPath, credential },
      { method: "GET", path: missingLookupPath, credential },
    ]);
  });

  it("restores the previous response after a route is scripted", async () => {
    const github = await startFakeGitHubApi();
    servers.push(github);
    const restore = github.scriptRoute("GET", "/user", {
      status: 503,
      body: { message: "temporary failure" },
    });

    const scripted = await fetch(`${github.baseUrl}/user`);
    expect(scripted.status).toBe(503);
    expect(await scripted.json()).toEqual({ message: "temporary failure" });

    restore();
    const restored = await fetch(`${github.baseUrl}/user`);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ login: "FakeGitHub" });
  });
});
