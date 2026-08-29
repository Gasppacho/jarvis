/**
 * Fastify's default `application/json` parser is secure-json-parse with
 * `protoAction: "error"`. The engine replaces that parser to tolerate an empty
 * body on the shutdown route, so it has to carry the same protection: without
 * it `{"__proto__": …}` arrives as an own property, ready to become a
 * prototype-pollution sink in a handler that merges or clones the body.
 */
export function parseJsonBody(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) =>
    key === "__proto__" || key === "constructor" ? undefined : value,
  );
}
