import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { API_VERSION, ENGINE_VERSION } from "./version.ts";

it("reports the version declared by the engine package", () => {
  const pkg = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  ) as { version: string };
  expect(ENGINE_VERSION).toBe(pkg.version);
});

it("speaks the API major the Local API path prefix declares", () => {
  expect(API_VERSION).toBe("v1");
});
