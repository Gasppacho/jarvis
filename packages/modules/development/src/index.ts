/**
 * Build-time entrypoint for the official Development Module Package.
 * Handler execution is introduced by the execution slice; the catalogue slice
 * only needs a real loadable package boundary and its declarative Manifest.
 */
export const developmentModulePackage = {
  id: "jarvis.module.development",
  version: "1.0.0",
} as const;
