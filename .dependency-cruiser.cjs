/**
 * Architecture rules from docs/architecture/SYSTEM.md "Dependency rules"
 * and docs/agents/coding-standards.md "DDD modulaire".
 */
module.exports = {
  forbidden: [
    {
      name: "no-module-to-module",
      severity: "error",
      comment:
        "A module is an executable bounded context. Modules integrate only through versioned events.",
      from: { path: "^packages/modules/([^/]+)/" },
      to: {
        path: "^packages/modules/([^/]+)/",
        pathNot: "^packages/modules/$1/",
      },
    },
    {
      name: "no-kernel-to-module",
      severity: "error",
      comment: "The Kernel holds shared mechanisms, never a concrete module.",
      from: { path: "^packages/kernel/" },
      to: { path: "^packages/modules/" },
    },
    {
      name: "no-kernel-to-project-runtime",
      severity: "error",
      comment: "The generic Kernel cannot own or depend on Project Runtime domain concepts.",
      from: { path: "^packages/kernel/" },
      to: { path: "^packages/project-runtime/" },
    },
    {
      name: "no-shell-to-engine-internals",
      severity: "error",
      comment: "The macOS shell talks to the engine only through the Local API contract.",
      from: { path: "^apps/macos/" },
      to: { path: "^(apps/engine|packages)/" },
    },
    {
      name: "no-http-to-project-service",
      severity: "error",
      comment:
        "HTTP adapters depend on the Kernel Project Registry port, never its concrete engine adapter.",
      from: { path: "^apps/engine/src/(http/|projects/routes\\.ts$)" },
      to: { path: "^apps/engine/src/projects/service\\.ts$" },
    },
    {
      name: "no-project-runtime-to-engine",
      severity: "error",
      comment: "Project Runtime owns its boundary and cannot depend on engine adapters.",
      from: { path: "^packages/project-runtime/" },
      to: { path: "^apps/engine/" },
    },
    {
      name: "no-project-runtime-to-module",
      severity: "error",
      comment: "Project Runtime composes manifests and ports, never module business code.",
      from: { path: "^packages/project-runtime/" },
      to: { path: "^packages/modules/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      // Generated API types are type-only imports, which read as orphans here.
      from: {
        orphan: true,
        pathNot: "(\\.d\\.ts$|/generated/|packages/modules/[^/]+/src/index\\.ts$)",
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|dist)" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "node"] },
  },
};
