import { defineConfig } from "vitest/config";

// Integration tests drive the built engine bundle over real loopback HTTP with a
// real temporary SQLite database. They need a longer budget than unit tests.
export default defineConfig({
  test: {
    include: ["apps/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
