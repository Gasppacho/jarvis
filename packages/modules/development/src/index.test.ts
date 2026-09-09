import { describe, expect, it } from "vitest";
import { buildChangeRequestIdempotencyKey } from "./index.js";

describe("Development outputs", () => {
  it("derives a stable bounded Change Request idempotency key", () => {
    const first = buildChangeRequestIdempotencyKey(
      "project",
      "main",
      "github://owner/repository/issues/42",
      "a".repeat(40),
    );

    expect(first).toBe(
      buildChangeRequestIdempotencyKey(
        "project",
        "main",
        "github://owner/repository/issues/42",
        "a".repeat(40),
      ),
    );
    expect(first).not.toBe(
      buildChangeRequestIdempotencyKey(
        "project",
        "main",
        "github://owner/repository/issues/42",
        "b".repeat(40),
      ),
    );
    expect(first).toMatch(/^change-request:[0-9a-f]{64}$/);
  });
});
