import { describe, expect, it } from "vitest";
import { ForbiddenJsonKeyError, parseJsonBody } from "./json.js";

describe("parseJsonBody", () => {
  it("parses an ordinary body", () => {
    expect(parseJsonBody('{"a":1,"b":["x"]}')).toEqual({ a: 1, b: ["x"] });
  });

  it("rejects __proto__ rather than quietly dropping it", () => {
    // Fastify's default parser answers 400 for this; a silent strip would turn
    // a refused pollution probe into a success.
    expect(() => parseJsonBody('{"__proto__":{"polluted":true}}')).toThrow(ForbiddenJsonKeyError);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("rejects a nested __proto__ as well", () => {
    expect(() => parseJsonBody('{"outer":{"__proto__":{"polluted":true}}}')).toThrow(
      ForbiddenJsonKeyError,
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("rejects constructor, which is the other pollution route", () => {
    expect(() => parseJsonBody('{"constructor":{"prototype":{"polluted":true}}}')).toThrow(
      ForbiddenJsonKeyError,
    );
  });

  it("still rejects malformed JSON", () => {
    expect(() => parseJsonBody("{not json")).toThrow(SyntaxError);
  });
});
