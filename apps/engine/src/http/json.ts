/** Thrown when a body carries a key that could reach Object.prototype. */
export class ForbiddenJsonKeyError extends Error {
  constructor(readonly key: string) {
    super(`Request body contains a forbidden key: ${key}.`);
    this.name = "ForbiddenJsonKeyError";
  }
}

/**
 * Fastify's default `application/json` parser is secure-json-parse with
 * `protoAction: "error"` and `constructorAction: "error"`: it *rejects* such a
 * body rather than cleaning it. The engine replaces that parser to tolerate an
 * empty body on the shutdown route, so it has to keep the same behaviour —
 * stripping silently would turn a refused pollution probe into a success, and
 * would slip keys past route schemas once those exist.
 */
export function parseJsonBody(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (key === "__proto__" || key === "constructor") throw new ForbiddenJsonKeyError(key);
    return value;
  });
}
