import { defineConfig } from "vitest/config";

// Unit tests live beside the code they cover; the Application Harness suite
// lives under `test/` because it drives the real built engine binary.
export default defineConfig({
  test: {
    // Each worker also launches real Engine/Git/Codex child processes. Keep
    // short deadline assertions meaningful instead of saturating the host.
    maxWorkers: 4,
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "apps/*/src/**/*.test.ts",
            "apps/*/scripts/**/*.test.mjs",
            "packages/**/src/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          globalSetup: ["apps/engine/test/global-setup.ts"],
          include: ["apps/*/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
