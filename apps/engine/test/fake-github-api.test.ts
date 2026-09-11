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

  it("serves repository issue events newest first with pagination and scoping", async () => {
    const github = await startFakeGitHubApi();
    servers.push(github);
    const credential = "ghs_events_sentinel";
    const first = github.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 42,
      issueTitle: "First issue",
      label: "ready-for-agent",
      actor: "alice",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const assigned = github.seedIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      event: {
        id: 100,
        created_at: "2026-09-02T10:00:00.000Z",
        event: "assigned",
        issue: { number: 43, title: "Assigned issue" },
        actor: { login: "bob" },
        assignee: { login: "carol" },
      },
    });
    const second = github.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 44,
      issueTitle: "Second issue",
      label: "agent:ready",
      actor: "dave",
      createdAt: "2026-09-03T10:00:00.000Z",
    });
    const otherRepository = github.appendLabeledIssueEvent({
      owner: "Other",
      repository: "repo",
      issueNumber: 1,
      issueTitle: "Other repository issue",
      label: "ready-for-agent",
      actor: "eve",
      createdAt: "2026-09-04T10:00:00.000Z",
    });

    expect(second.id).not.toBe(first.id);

    const path = "/repos/Gasppacho/jarvis/issues/events";
    const pageOnePath = `${path}?per_page=2&page=1`;
    const pageOne = await fetch(`${github.baseUrl}${pageOnePath}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(pageOne.status).toBe(200);
    expect(await pageOne.json()).toEqual([second, assigned]);

    const pageTwoPath = `${path}?per_page=2&page=2`;
    const pageTwo = await fetch(`${github.baseUrl}${pageTwoPath}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(pageTwo.status).toBe(200);
    expect(await pageTwo.json()).toEqual([first]);

    const pagePastEnd = await fetch(`${github.baseUrl}${path}?per_page=2&page=3`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(pagePastEnd.status).toBe(200);
    expect(await pagePastEnd.json()).toEqual([]);

    const other = await fetch(`${github.baseUrl}/repos/Other/repo/issues/events`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual([otherRepository]);
    expect(github.requests).toContainEqual({
      method: "GET",
      path: pageOnePath,
      credential,
    });
  });

  it("reads seeded labelled issues and allows body overrides without an event", async () => {
    const github = await startFakeGitHubApi();
    servers.push(github);
    const credential = "ghs_issue_sentinel";
    github.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 42,
      issueTitle: "Read the issue",
      issueBody: "Initial body",
      issueState: "open",
      label: "agent:ready",
      actor: "octocat",
      createdAt: "2026-09-11T10:00:00.000Z",
    });

    const path = "/repos/Gasppacho/jarvis/issues/42";
    const initial = await fetch(`${github.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      number: 42,
      title: "Read the issue",
      body: "Initial body",
      state: "open",
      labels: [{ name: "agent:ready" }],
    });

    github.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 42,
        title: "Read the issue",
        body: "Overridden body",
        state: "open",
        labels: [{ name: "agent:ready" }],
      },
    });
    const overridden = await fetch(`${github.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(overridden.status).toBe(200);
    expect(await overridden.json()).toMatchObject({ body: "Overridden body" });
    expect(github.requests).toEqual([
      { method: "GET", path, credential },
      { method: "GET", path, credential },
    ]);
  });

  it("returns a GitHub-shaped 404 and supports scripted issue responses", async () => {
    const github = await startFakeGitHubApi();
    servers.push(github);
    const path = "/repos/Gasppacho/jarvis/issues/404";
    const missing = await fetch(`${github.baseUrl}${path}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "Not Found" });

    const restore = github.scriptRoute("GET", path, {
      status: 401,
      body: { message: "Requires authentication" },
    });
    const unauthorized = await fetch(`${github.baseUrl}${path}`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ message: "Requires authentication" });
    restore();

    const restored = await fetch(`${github.baseUrl}${path}`);
    expect(restored.status).toBe(404);
    expect(github.requests).toEqual([
      { method: "GET", path, credential: undefined },
      { method: "GET", path, credential: undefined },
      { method: "GET", path, credential: undefined },
    ]);
  });

  it("scripts and restores the issue events route", async () => {
    const github = await startFakeGitHubApi();
    servers.push(github);
    const path = "/repos/Gasppacho/jarvis/issues/events";
    const restore = github.scriptRoute("GET", path, {
      status: 503,
      body: { message: "temporary failure" },
    });

    const scripted = await fetch(`${github.baseUrl}${path}`);
    expect(scripted.status).toBe(503);
    expect(await scripted.json()).toEqual({ message: "temporary failure" });

    restore();
    const event = github.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 15,
      issueTitle: "Poll GitHub labels",
      label: "ready-for-agent",
      actor: "FakeGitHub",
      createdAt: "2026-09-11T10:00:00.000Z",
    });
    const restored = await fetch(`${github.baseUrl}${path}`);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual([event]);
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
