/** Replaced at build time by tsup; the fallback keeps type-check and tests honest. */
declare const __ENGINE_VERSION__: string | undefined;

export const ENGINE_VERSION: string =
  typeof __ENGINE_VERSION__ === "string" ? __ENGINE_VERSION__ : "0.0.0-dev";
export const API_VERSION = "v1" as const;
