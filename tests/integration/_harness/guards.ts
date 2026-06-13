import { EventEmitter } from "node:events";
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

/** Connect a streamer, assert `connected` within timeout; best-effort shape-check the first `market`. */
export async function assertStreamsLive(
  stream: EventEmitter & { subscribe: (s: string[]) => void; start: () => Promise<void> | void; stop: () => Promise<void> | void },
  symbols: string[],
  provider: "alpaca" | "finnhub" | "yahoo",
  connectMs = 5000,
): Promise<void> {
  const connected = new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no 'connected' within ${connectMs}ms`)), connectMs);
    stream.once("connected", () => { clearTimeout(t); res(); });
    stream.once("error", (e) => { clearTimeout(t); rej(new Error(`stream error: ${String(e)}`)); });
  });
  stream.subscribe(symbols);
  await stream.start();
  await connected; // hard gate

  // best-effort: if a market frame arrives within a short window, shape-check it.
  await new Promise<void>((res) => {
    const t = setTimeout(() => res(), 4000);
    stream.once("market", (ev: Record<string, unknown>) => {
      clearTimeout(t);
      if (ev) {
        if (!["trade", "quote"].includes(String(ev.type))) throw new Error(`bad market.type: ${ev.type}`);
        for (const f of ["ticker", "timestamp", "price"]) if (!(f in ev)) throw new Error(`market missing ${f}`);
        if (!(provider in ev)) throw new Error(`market missing provider key ${provider}`);
      }
      res();
    });
  });
  await stream.stop();
}
