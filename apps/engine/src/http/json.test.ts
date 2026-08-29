import { describe, expect, it } from "vitest";
import { parseJsonBody } from "./json.js";

describe("parseJsonBody", () => {
  it("parses an ordinary body", () => {
    expect(parseJsonBody('{"a":1,"b":["x"]}')).toEqual({ a: 1, b: ["x"] });
  });

  it("drops __proto__ instead of letting it through as an own property", () => {
    const parsed = parseJsonBody('{"__proto__":{"polluted":true},"keep":1}') as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(parsed, "__proto__")).toBe(false);
    expect(parsed["keep"]).toBe(1);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("drops a nested __proto__ as well", () => {
    const parsed = parseJsonBody('{"outer":{"__proto__":{"polluted":true}}}') as {
      outer: Record<string, unknown>;
    };

    expect(Object.hasOwn(parsed.outer, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("drops constructor, which is the other pollution route", () => {
    const parsed = parseJsonBody('{"constructor":{"prototype":{"polluted":true}}}') as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(parsed, "constructor")).toBe(false);
  });

  it("still rejects malformed JSON", () => {
    expect(() => parseJsonBody("{not json")).toThrow();
  });
});
