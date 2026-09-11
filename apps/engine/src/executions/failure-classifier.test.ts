import { describe, expect, it } from "vitest";
import { EngineError } from "../errors.js";
import { classifyHandlerFailure } from "./delivery-consumer.js";

describe("classifyHandlerFailure", () => {
  it("preserves a Module failure's code and retryability", () => {
    const failure = Object.assign(new Error("module failure"), {
      code: "module.example-failed",
      retryable: false,
    });

    expect(classifyHandlerFailure(failure)).toEqual({
      code: "module.example-failed",
      retryable: false,
      message: "module failure",
    });
  });

  it.each([
    [new EngineError("api.invalid-request", 400, "validation failed"), "validation"],
    [new Error("permission denied by the provider"), "permission"],
  ])("classifies %s failures as permanent", (error) => {
    expect(classifyHandlerFailure(error).retryable).toBe(false);
  });

  it.each([
    [new Error("network temporarily unavailable"), "network"],
    [Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" }), "timeout"],
  ])("classifies %s failures as retryable", (error) => {
    expect(classifyHandlerFailure(error).retryable).toBe(true);
  });

  it("maps an unknown error to a stable retryable internal code", () => {
    expect(classifyHandlerFailure(new Error("opaque failure"))).toEqual({
      code: "system.internal-error",
      retryable: true,
      message: "opaque failure",
    });
  });

  it("cleans secrets and absolute host paths from the message", () => {
    const secret = "ghs_handler_failure_secret";
    const message =
      `request failed token=${secret} at /Users/alice/jarvis/.git/config ` +
      "Authorization: Bearer bearer-secret";

    const classified = classifyHandlerFailure(new Error(message));

    expect(classified.message).not.toContain(secret);
    expect(classified.message).not.toContain("bearer-secret");
    expect(classified.message).not.toContain("/Users/alice/jarvis");
    expect(classified.message).toContain("<redacted>");
    expect(classified.message).toContain("<path>");
  });

  it("preserves JSON pointers while redacting single-component absolute paths", () => {
    const classified = classifyHandlerFailure(new Error("failed at /tmp and schema /payload/file"));

    expect(classified.message).toBe("failed at <path> and schema /payload/file");
  });

  it.each(["/srv", "/foo", "/usr", "/var/log"])(
    "redacts the complete POSIX path token %s",
    (path) => {
      const classified = classifyHandlerFailure(new Error(`failed at ${path}`));

      expect(classified.message).toBe("failed at <path>");
      expect(classified.message).not.toContain(path);
    },
  );

  it("does not persist arbitrary failure codes", () => {
    expect(
      classifyHandlerFailure(
        Object.assign(new Error("bad"), { code: "token=secret", retryable: false }),
      ).code,
    ).toBe("system.internal-error");
  });
});
