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
      name: "no-shell-to-engine-internals",
      severity: "error",
      comment: "The macOS shell talks to the engine only through the Local API contract.",
      from: { path: "^apps/macos/" },
      to: { path: "^(apps/engine|packages)/" },
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
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "node"] },
  },
};
