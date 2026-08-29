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
 *
 * `constructor` is refused only when it carries a `prototype`, which is what
 * makes it dangerous. Refusing the bare name would reject a legitimate body
 * that simply has a field called "constructor".
 */
export function parseJsonBody(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (key === "__proto__") throw new ForbiddenJsonKeyError(key);
    if (key === "constructor" && hasOwnPrototype(value)) throw new ForbiddenJsonKeyError(key);
    return value;
  });
}

function hasOwnPrototype(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "prototype");
}
