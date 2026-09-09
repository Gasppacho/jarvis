import { isAbsolute, relative, resolve } from "node:path";
import type { AgentRunRequest, AgentRunResult } from "./types.js";
import type { AgentRunObservation, AgentRunTranslator } from "./child-process-agent-run.js";

/** Fake-specific protocol decoding; process lifecycle stays in ChildProcessAgentRun. */
export class FakeRuntimeTranslator implements AgentRunTranslator {
  private readonly observedChangedFiles: string[] = [];

  public constructor(private readonly request: AgentRunRequest) {}

  public translate(line: string): readonly AgentRunObservation[] {
    const trimmed = line.trim();
    if (trimmed === "") return [];

    let record: unknown;
    try {
      record = JSON.parse(trimmed) as unknown;
    } catch {
      return [{ type: "warning", message: "Fake Runtime emitted malformed JSON output." }];
    }

    if (!isRecord(record) || typeof record["type"] !== "string") {
      return [{ type: "stdout", chunk: line }];
    }

    switch (record["type"]) {
      case "message":
        return typeof record["message"] !== "string"
          ? [{ type: "warning", message: "Fake Runtime emitted an invalid message line." }]
          : [{ type: "message", message: record["message"] }];
      case "file-changed": {
        const path = record["path"];
        if (!isSafeRelativePath(path, this.request.workingDirectory)) {
          return [{ type: "warning", message: "Fake Runtime reported an invalid changed file." }];
        }
        this.observedChangedFiles.push(path);
        return [{ type: "file-changed", path }];
      }
      case "result": {
        let result: AgentRunResult;
        try {
          result = readChildResult(record, this.request.workingDirectory);
        } catch (error) {
          result = failedResult(
            "agent.invalid-result",
            error instanceof Error ? error.message : String(error),
            false,
          );
        }
        if (
          result.status === "completed" &&
          !sameFiles(result.changedFiles, this.observedChangedFiles)
        ) {
          result = failedResult(
            "agent.protocol-invalid",
            "The Fake Runtime result disagrees with its file-changed events.",
            false,
          );
        }
        return [{ type: "result", result }];
      }
      case "warning":
        return [
          {
            type: "warning",
            message:
              typeof record["message"] === "string"
                ? record["message"]
                : "Fake Runtime emitted a warning.",
          },
        ];
      default:
        return [{ type: "stdout", chunk: line }];
    }
  }
}

function readChildResult(value: unknown, workingDirectory: string): AgentRunResult {
  if (isRecord(value) && value["status"] === "completed") {
    return readCompletedResult(value, workingDirectory);
  }
  if (isRecord(value) && value["status"] === "failed") {
    return failedResult(
      "agent.child-failed",
      typeof value["message"] === "string" ? value["message"] : "Fake Runtime reported failure.",
      false,
    );
  }
  throw new Error("The Fake Runtime returned an invalid result line.");
}

function readCompletedResult(value: unknown, workingDirectory: string): AgentRunResult {
  if (!isRecord(value) || value["status"] !== "completed") {
    throw new Error("The Fake Runtime returned an invalid completed result.");
  }
  const summary = value["summary"];
  const changedFiles = value["changedFiles"];
  if (
    typeof summary !== "string" ||
    summary.length === 0 ||
    !Array.isArray(changedFiles) ||
    !changedFiles.every((file): file is string => typeof file === "string")
  ) {
    throw new Error("The Fake Runtime completed result has an invalid shape.");
  }
  for (const file of changedFiles) {
    if (!isSafeRelativePath(file, workingDirectory)) {
      throw new Error("The Fake Runtime returned a changed file outside its working directory.");
    }
  }
  return { status: "completed", summary, changedFiles: [...changedFiles] };
}

function failedResult(code: string, message: string, retryable: boolean): AgentRunResult {
  return {
    status: "failed",
    summary: "Fake Runtime failed.",
    changedFiles: [],
    error: { code, message, retryable },
  };
}

function isSafeRelativePath(value: unknown, workingDirectory: string): value is string {
  if (typeof value !== "string" || value === "" || isAbsolute(value)) return false;
  const resolved = resolve(workingDirectory, value);
  const relativePath = relative(workingDirectory, resolved);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const FAKE_CHILD_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn: spawnChild } = require("node:child_process");
delete process.env.__CF_USER_TEXT_ENCODING;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input || "{}");
  const emit = record => process.stdout.write(JSON.stringify(record) + "\n");
  if (request.scenario === "inspect") {
    const file = "fake-runtime-working-directory.txt";
    fs.writeFileSync(path.join(process.cwd(), file), process.cwd());
    emit({ type: "message", message: JSON.stringify({ cwd: process.cwd(), environment: process.env }) });
    emit({ type: "file-changed", path: file });
    emit({
      type: "result",
      status: "completed",
      summary: "Fake Runtime inspected its process context.",
      changedFiles: [file]
    });
    return;
  }
  if (request.scenario === "failure") {
    process.stderr.write("deterministic fake failure\n");
    process.exit(7);
  }
  if (request.scenario === "ignore-terminate" ||
      (request.scenario === "repair-ignore-terminate" && request.repair)) {
    const child = spawnChild(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    const marker = request.scenario === "ignore-terminate" ? "fake-runtime-child" : "fake-runtime-repair-child";
    fs.writeFileSync(marker + ".pid", String(child.pid));
    const interrupt =
      request.scenario === "ignore-terminate"
        ? "fake-runtime-interrupt.txt"
        : "fake-runtime-repair-child-interrupt.txt";
    process.on("SIGTERM", () => fs.writeFileSync(interrupt, "graceful\n"));
    setInterval(() => {}, 1000);
    return;
  }
  if (request.scenario === "clean") {
    emit({
      type: "result",
      status: "completed",
      summary: "Fake Runtime left the worktree unchanged.",
      changedFiles: [],
    });
    return;
  }
  if (request.scenario === "stderr" || request.scenario === "noisy") process.stderr.write("deterministic stderr output\n");
  if (request.scenario === "malformed" || request.scenario === "noisy") process.stdout.write("{malformed json\n");
  if (request.scenario === "unknown" || request.scenario === "noisy") process.stdout.write(JSON.stringify({ type: "unrecognized", value: "deterministic raw stdout" }) + "\n");
  if (request.scenario === "oversized") process.stdout.write("x".repeat(131072) + "\n");
  const changedFiles = [];
  if (request.scenario === "repair" && request.repair) {
    emit({ type: "message", message: "Repair context: " + request.repairContext });
    const fix = "validation-fix.txt";
    fs.writeFileSync(path.join(process.cwd(), fix), "fixed\n");
    changedFiles.push(fix);
    emit({ type: "file-changed", path: fix });
  }
  const file = "fake-runtime-change.txt";
  fs.writeFileSync(path.join(process.cwd(), file), "Fake Runtime deterministic change.\n");
  if (!(request.scenario === "repair" && request.repair)) {
    emit({ type: "message", message: "Fake Runtime applied deterministic change." });
  }
  emit({ type: "file-changed", path: file });
  changedFiles.push(file);
  emit({
    type: "result",
    status: "completed",
    summary: "Fake Runtime applied deterministic change.",
    changedFiles
  });
});
`;
