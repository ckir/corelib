// Browser-safe entry point for @ckirg/corelib.
// Only exports that are free of Node.js / Bun / Deno runtime dependencies.

export type { LogMethod, StrictLogger } from "./loggers/common/index.js";
export { default as logger } from "./loggers/implementations/browser.js";
// Flight-recorder correlation primitive — a pure process-counter with zero runtime
// deps, so it is safe in edge/worker bundles (ts-cloud resolves the browser export
// and needs nextCid for per-request rid).
export { type FlightRecorderExtras, nextCid } from "./utils/flight-recorder.js";
