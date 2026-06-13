import { describe } from "vitest";
import { isFfiAvailable } from "@ckir/corelib";

/** Skip the suite (loudly) when the native addon isn't present for this platform. */
export const ffiDescribe: typeof describe = (() => {
  const available = (() => { try { return isFfiAvailable(); } catch { return false; } })();
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn("\x1b[33m[itest] FFI UNAVAILABLE — skipping ffi-scalar/streaming suites (no corelib-rust.node for this platform/arch). Coverage hole is intentional, not silent.\x1b[0m");
  }
  return describe.skipIf(!available) as typeof describe;
})();

/** Skip the suite unless INTEGRATION_LIVE=1 (streaming + real-network tiers). */
export const liveDescribe: typeof describe = describe.skipIf(process.env.INTEGRATION_LIVE !== "1") as typeof describe;

/** True if every named env var is set; otherwise logs a loud skip reason and returns false. */
export function requireEnv(label: string, names: string[]): boolean {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`\x1b[33m[itest] SKIP ${label}: missing env ${missing.join(", ")}\x1b[0m`);
    return false;
  }
  return true;
}
