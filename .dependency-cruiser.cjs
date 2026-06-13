/** Audit Phase-0 rules. dependency-cruiser is already a devDep. */
module.exports = {
  forbidden: [
    {
      name: "markets-cloud-depend-only-on-core",
      comment: "ts-markets/ts-cloud may import ts-core, never each other or back-channels (AGENTS.md §1).",
      severity: "error",
      from: { path: "^ts-(markets|cloud)/src" },
      to: { path: "^ts-(markets|cloud)/src", pathNot: "^ts-core/src" },
    },
    {
      name: "ts-core-no-node-builtins",
      comment: "ts-core is multi-runtime-first; no hard Node-only built-in imports (spec §4.1).",
      severity: "error",
      from: { path: "^ts-core/src", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["core"], path: "^(node:)?(fs|path|module|child_process|os|net|tls|crypto|worker_threads)$" },
    },
  ],
  options: { doNotFollow: { path: "node_modules" }, tsPreCompilationDeps: true },
};
