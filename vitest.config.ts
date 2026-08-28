import { defineConfig } from "vitest/config";

// Unit tests live beside the code they cover; the Application Harness suite
// lives under `test/` because it drives the real built engine binary.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["apps/*/src/**/*.test.ts"],
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
