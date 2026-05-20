// Browser-safe entry point for @ckir/corelib.
// Only exports that are free of Node.js / Bun / Deno runtime dependencies.

export type { LogMethod, StrictLogger } from "./loggers/common/index.js";
export { default as logger } from "./loggers/implementations/browser.js";
