import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeDetector } from "./detector.js";

const roots: string[] = [];

describe("RuntimeDetector", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("returns the first executable candidate without starting the shell", async () => {
    const root = await makeRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    const shellMarker = join(root, "shell-started");
    await writeExecutable(first);
    await writeExecutable(second);
    const shell = await makeShell(root, `printf '%s' yes > "$JARVIS_DETECTOR_MARKER"`);

    await expect(
      new RuntimeDetector({
        knownExecutablePaths: [join(root, "missing"), first, second],
        shellPath: shell,
        shellEnvironment: { JARVIS_DETECTOR_MARKER: shellMarker },
      }).detect("codex"),
    ).resolves.toBe(first);
    await expect(pathExists(shellMarker)).resolves.toBe(false);
  });

  it("passes the command name as an argv value to one login-shell probe", async () => {
    const root = await makeRoot();
    const executable = join(root, "codex");
    const argsMarker = join(root, "args");
    await writeExecutable(executable);
    const shell = await makeShell(
      root,
      [
        'printf "%s\\n" "$1" "$2" "$3" "$4" > "$JARVIS_DETECTOR_ARGS"',
        'printf "%s\\n" "$JARVIS_DETECTOR_RESULT"',
      ].join("\n"),
    );

    await expect(
      new RuntimeDetector({
        knownExecutablePaths: [],
        shellPath: shell,
        shellEnvironment: {
          JARVIS_DETECTOR_ARGS: argsMarker,
          JARVIS_DETECTOR_RESULT: executable,
        },
      }).detect("codex"),
    ).resolves.toBe(executable);

    const [option, script, arg0, command] = (await readFile(argsMarker, "utf8")).split("\n");
    expect(option).toBe("-ilc");
    expect(script).toBe('command -v -- "$1"');
    expect(arg0).toBe("jarvis-runtime-detector");
    expect(command).toBe("codex");
  });

  it("finds a known candidate when shell probing is disabled", async () => {
    const root = await makeRoot();
    const executable = join(root, "codex");
    const shellMarker = join(root, "shell-started");
    await writeExecutable(executable);
    const shell = await makeShell(root, `printf '%s' yes > "$JARVIS_DETECTOR_MARKER"`);

    await expect(
      new RuntimeDetector({
        knownExecutablePaths: [executable],
        allowShellProbe: false,
        shellPath: shell,
        shellEnvironment: { JARVIS_DETECTOR_MARKER: shellMarker },
      }).detect("codex"),
    ).resolves.toBe(executable);
    await expect(pathExists(shellMarker)).resolves.toBe(false);
  });

  it.each(["", "codex\nmalicious", "../codex", "codex name", "codex;touch"])(
    "rejects unsafe command name %j before probing",
    async (commandName) => {
      const root = await makeRoot();
      const shellMarker = join(root, "shell-started");
      const shell = await makeShell(root, `printf '%s' yes > "$JARVIS_DETECTOR_MARKER"`);

      await expect(
        new RuntimeDetector({
          knownExecutablePaths: [],
          shellPath: shell,
          shellEnvironment: { JARVIS_DETECTOR_MARKER: shellMarker },
        }).detect(commandName),
      ).rejects.toThrow(TypeError);
      await expect(pathExists(shellMarker)).resolves.toBe(false);
    },
  );

  it("rejects malformed shell output and invalid resolved files", async () => {
    const root = await makeRoot();
    const directory = join(root, "directory");
    const nonExecutable = join(root, "non-executable");
    const missing = join(root, "missing");
    await mkdir(directory);
    await writeFile(nonExecutable, "not executable");
    await chmod(nonExecutable, 0o644);
    const shell = await makeShell(root, 'printf "%s" "$JARVIS_DETECTOR_OUTPUT"');

    const outputs = [
      "",
      "relative/path\n",
      `${join(root, "one")}\n${join(root, "two")}\n`,
      "codex: aliased to /tmp/codex\n",
      "codex () { command -v codex; }\n",
      `${directory}\n`,
      `${nonExecutable}\n`,
      `${missing}\n`,
    ];
    for (const output of outputs) {
      await expect(
        new RuntimeDetector({
          knownExecutablePaths: [],
          shellPath: shell,
          shellEnvironment: { JARVIS_DETECTOR_OUTPUT: output },
        }).detect("codex"),
      ).resolves.toBeNull();
    }
  });

  it("kills a hanging login shell and returns not-found", async () => {
    const root = await makeRoot();
    const pidMarker = join(root, "pid");
    const shell = await makeShell(
      root,
      ['printf "%s" "$$" > "$JARVIS_DETECTOR_PID"', "trap '' TERM", "while :; do :; done"].join(
        "\n",
      ),
    );
    const startedAt = Date.now();

    const result = await new RuntimeDetector({
      knownExecutablePaths: [],
      shellPath: shell,
      shellEnvironment: { JARVIS_DETECTOR_PID: pidMarker },
      timeoutMs: 1_000,
    }).detect("codex");

    expect(result).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const pid = Number.parseInt(await readFile(pidMarker, "utf8"), 10);
    await expectProcessGone(pid);
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jarvis-runtime-detector-"));
  roots.push(root);
  return root;
}

async function writeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

async function makeShell(root: string, body: string): Promise<string> {
  const shell = join(root, "shell");
  await writeFile(shell, `#!/bin/sh\n${body}\n`);
  await chmod(shell, 0o755);
  return shell;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error(`Process ${pid} is still alive.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
