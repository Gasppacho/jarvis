import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

// The Application Harness drives the real engine bundle, so the suite builds it
// once instead of importing the TypeScript sources directly.
export default function setup(): void {
  execFileSync("pnpm", ["--filter", "@jarvis/engine", "run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
