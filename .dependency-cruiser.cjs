/**
 * Architecture rules (AGENTS.md §1). The "browser bundle has no Node builtins" guarantee is checked on the built output by scripts/check-browser-bundle.mjs. Run with `pnpm deps:check`; it runs in pre-commit-adjacent
 * `verify:fast` and in the CI validate job. tsConfig is set so `@ckirg/corelib*` imports resolve to
 * the workspace sources through tsconfig.base.json `paths`; without it cross-package rules cannot fire.
 */
const TESTS = "\\.test\\.ts$|/test-utils/";

module.exports = {
  forbidden: [
    {
      name: "core-independent-of-extensions",
      comment: "ts-core is the base layer: it must not import ts-markets or ts-cloud.",
      severity: "error",
      from: { path: "^ts-core/src" },
      to: { path: "^ts-(markets|cloud)/src" },
    },
    {
      name: "markets-independent-of-cloud",
      comment: "ts-markets must not import ts-cloud (ts-cloud may use ts-markets, never the reverse).",
      severity: "error",
      from: { path: "^ts-markets/src" },
      to: { path: "^ts-cloud/src" },
    },
    {
      name: "extensions-use-core-public-entry",
      comment:
        "ts-markets/ts-cloud may only import ts-core through its package entry points (@ckirg/corelib), never its internals.",
      severity: "error",
      from: { path: "^ts-(markets|cloud)/src", pathNot: TESTS },
      to: { path: "^ts-core/src", pathNot: "^ts-core/src/(index|browser)\\.ts$" },
    },
    {
      name: "logger-implementations-are-private",
      comment:
        "Logger implementations are selected per runtime by ts-core/src/loggers/index.ts (and the browser entry); nothing else may import them.",
      severity: "error",
      from: {
        path: "^ts-(core|markets|cloud)/src",
        pathNot: ["^ts-core/src/loggers/", "^ts-core/src/browser\\.ts$", TESTS],
      },
      to: { path: "^ts-core/src/loggers/implementations/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    exclude: { path: "(^|/)dist/" },
  },
};
