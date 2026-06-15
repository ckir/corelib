// =============================================
// PROBE: correlation-id-absent  (Epic 5, Phase 2, Task 2.5, Cluster 4 — architecture)
// =============================================
// HYPOTHESIS (spec Cluster 4): there is NO explicit correlation/trace id threaded across the
// `#[napi]` streaming boundary, so a `trace_id` a TS caller might want to attach cannot reach the
// Rust flight-recorder events for that stream. Per the spec, the correct design threads an EXPLICIT
// trace_id through the FFI boundary (NOT via AsyncLocalStorage / thread_local! — the tokio tasks jump
// threads), surfaced as a structured field on the flight events.
//
// This is a DESIGN probe: it confirms the ABSENCE by the public API shape and is expected to report
// `PROBE_CONFIRMED correlation-id-absent`. It is a SOFT-GATE backlog item (observability completeness,
// severity medium) — NOT a hard gate: error-mapping is coherent (construction/init errors surface via
// `napi::Error::from_reason`; provider errors via `ProviderStatus::Error -> on_event`), so no error is
// lost across the boundary. The full explicit-context threading is deferred to a dedicated change.
//
// State-verified (2026-06-15): `AlpacaConfig` = { db_path, silence_seconds, base_url, key_id,
// secret_key } — no trace_id; init/start/subscribe take no correlation arg; flight-recorder events
// (observed via napiDumpFlightLog: "connect attempt=0", "sub request channel=trades symbols=1")
// carry no correlation id.
// =============================================

import { describe, expect, it } from "vitest";
import { coreFFI } from "../../ts-core/dist/index.js";

describe("correlation-id FFI context (design probe)", () => {
  it("PROBE_CONFIRMED correlation-id-absent: no trace_id seam across the #[napi] boundary", () => {
    const noop = () => {};
    const s = new coreFFI.AlpacaStreaming(noop, noop, noop, noop);

    // There is no API to thread a correlation/trace id: no constructor arg, no init field, and no
    // dedicated setter. A `trace_id` passed in the init config is silently dropped by napi
    // deserialization (AlpacaConfig has no such field). This asserts the DESIGN GAP, not a fault.
    const hasTraceSeam =
      typeof s.setTraceId === "function" || typeof s.withTraceId === "function";

    console.log(`PROBE_CONFIRMED correlation-id-absent trace_seam=${hasTraceSeam}`);
    expect(hasTraceSeam).toBe(false); // confirms absence — backlog the explicit-context design
  });
});
