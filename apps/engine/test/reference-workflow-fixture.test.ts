import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  startReferenceWorkflowFixture,
  type ReferenceWorkflowFixture,
} from "./reference-workflow-fixture.js";

const fixtures: ReferenceWorkflowFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("reference workflow Application Harness", () => {
  it("composes, activates, and starts polling without chaining an event", async () => {
    const fixture = await startReferenceWorkflowFixture();
    fixtures.push(fixture);

    expect(fixture.repositoryRoot.startsWith(tmpdir())).toBe(true);
    expect(fixture.bareRemoteRoot.startsWith(tmpdir())).toBe(true);
    expect(fixture.initialCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(fixture.repositoryRoot, ["rev-parse", "HEAD"])).toBe(fixture.initialCommitSha);
    expect(gitDir(fixture.bareRemoteRoot, ["rev-parse", "refs/heads/main"])).toBe(
      fixture.initialCommitSha,
    );

    const configuration = parseYaml(
      readFileSync(join(fixture.repositoryRoot, ".jarvis/project.yaml"), "utf8"),
    ) as {
      readonly modules: readonly {
        readonly instanceId: string;
        readonly bindings?: Readonly<Record<string, string>>;
        readonly configuration?: Readonly<Record<string, unknown>>;
      }[];
    };
    const automation = configuration.modules.find(
      (module) => module.instanceId === "automation-rules",
    );
    expect(automation?.configuration?.["rules"]).toEqual([
      expect.objectContaining({
        emit: {
          type: "development.implementation.requested",
          target: { moduleInstanceId: "development" },
        },
      }),
    ]);
    expect(configuration.modules.map(({ instanceId }) => instanceId)).toEqual([
      "github",
      "automation-rules",
      "development",
    ]);

    expect(
      fixture.fakeGitHub.requests.some(
        (request) =>
          request.path === "/repos/Gasppacho/jarvis/issues/events" &&
          request.credential === "ghs_reference_fixture",
      ),
    ).toBe(true);
    const events = await fixture.engine.call(`/v1/projects/${fixture.projectId}/events`);
    const executions = await fixture.engine.call(`/v1/projects/${fixture.projectId}/executions`);
    expect(events.status).toBe(200);
    expect(executions.status).toBe(200);
    const [eventBody, executionBody] = await Promise.all([events.text(), executions.text()]);
    expect(`${eventBody}\n${executionBody}`).not.toContain("ghs_reference_fixture");
    expect(fixture.engine.stdoutLines.join("\n")).not.toContain("ghs_reference_fixture");
    expect(fixture.engine.stderr()).not.toContain("ghs_reference_fixture");
  });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitDir(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["--git-dir", cwd, ...args], { encoding: "utf8" }).trim();
}
