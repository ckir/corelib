// =============================================
// CHILD HARNESS: transport-backpressure-child.mjs  (Epic 5 Cluster-1, Task 2.2)
// =============================================
// Process-isolated worker for the transport backpressure probe.
// MUST be run with `--expose-gc`.
//
// Hypothesis (Cluster 1): the NonBlocking TSFN (cap=1024, fixed in commit
// 1aedbcf0) drops frames when the JS consumer starves the pump. Native RSS
// should remain BOUNDED because dropped calls never queue off-heap. Without the
// fix (unbounded Blocking), outstanding calls would accumulate in the native
// TSFN queue, causing RSS to grow proportionally to the flood size.
//
// Design: start a REAL AlpacaStreaming pointed at an in-process loopback.
// Once the Rust driver reaches the streaming state, flood trade frames as fast
// as possible via server.streamTradeAll(). Every 500th on_pricing callback
// busy-spins 150 ms to block the event loop, pressuring the TSFN queue.
// After the flood + drain, report baseline/terminal RSS+heap and sent/received
// counts so the parent can compute native_growth_mb and drop_pct.
//
// Unlike Task 2.1 (napiLoadGenerator / Blocking TSFN), this probe exercises
// the PRODUCTION path: real streamer -> real alpaca driver -> NonBlocking TSFN
// calls -> JS on_pricing. No latency ring, no napiLoadGenerator.
//
// Environment note: in some environments (debug native builds, specific tokio_rt
// configurations on Windows) the tokio timer driver does not advance after the
// first connection attempt, causing the supervisor reconnect sleep to stall.
// In this case the streamer never reaches streaming state and RECEIVED=0.
// The probe reports STREAM_READY=0/1 so the adjudicator can distinguish a real
// measurement from an environment-constrained partial run.
//
// Output contract (parsed by parent):
//   BASELINE_RSS=<bytes>
//   BASELINE_HEAP=<bytes>
//   TERMINAL_RSS=<bytes>
//   TERMINAL_HEAP=<bytes>
//   SENT=<n>
//   RECEIVED=<n>
//   STREAM_READY=<0|1>
// On any failure: CHILD_ERROR <msg> + exit non-zero.
// =============================================

import { coreFFI } from "../../ts-core/dist/index.js";
import { AlpacaLoopbackServer } from "./alpaca-loopback.mjs";

// --- Guards ---
if (typeof global.gc !== "function") {
  console.log("CHILD_ERROR global.gc unavailable (need --expose-gc)");
  process.exit(3);
}

if (!coreFFI || typeof coreFFI.AlpacaStreaming !== "function") {
  console.log("CHILD_ERROR coreFFI.AlpacaStreaming unavailable (native addon not loaded or missing AlpacaStreaming)");
  process.exit(3);
}

// --- Config ---
const FLOOD_MS = 5_000;        // duration of the trade-frame flood
const DRAIN_MS = 2_000;        // slack after flood for queue drain + final callbacks
const STREAM_READY_POLL_MS = 100;
// Generous poll window: the default reconnect policy uses jitter 2.5-5s initial
// delay, so we give it up to 12s to connect (allowing for 1-2 retries).
const STREAM_READY_TIMEOUT_MS = 12_000;

/** @returns {{ rss: number, heapUsed: number }} */
function gcThenMem() {
  global.gc();
  global.gc();
  const { rss, heapUsed } = process.memoryUsage();
  return { rss, heapUsed };
}

try {
  const server = new AlpacaLoopbackServer();
  await server.listen();

  let received = 0;
  const noop = () => {};

  // on_pricing: increment counter and, every 500th call, busy-spin 150 ms to
  // starve the pump — this is the key stress: blocks the JS event loop so the
  // native TSFN queue is pressured on every subsequent NonBlocking call.
  const onPricing = () => {
    received++;
    if (received % 500 === 0) {
      const spinEnd = Date.now() + 150;
      while (Date.now() < spinEnd) { /* busy wait */ }
    }
  };

  // Construct with all 4 callbacks — mirrors ffi-reconnect-child.mjs exactly
  // so BOTH TSFNs in the pump closure fire (alpaca_streamer.rs:189-194).
  const streamer = new coreFFI.AlpacaStreaming(noop, onPricing, noop, noop);

  // Point at the loopback; dummy creds so validate() passes.
  await streamer.init({
    base_url: server.url,
    key_id: "probe-key",
    secret_key: "probe-secret",
    silence_seconds: 60,
  });

  // Seed subscription before start so the driver's initial subscribe is
  // non-empty (load_subscriptions reads redb on every connect -> ack path).
  await streamer.subscribe({ trades: ["AAPL"], quotes: ["AAPL"] });

  await streamer.start();

  // Poll until the Rust driver has completed the alpaca handshake and is
  // streaming-ready. If this times out (environment limitation), we continue
  // anyway and report STREAM_READY=0 so the adjudicator knows the measurement
  // was partial (no TSFN pressure, so RECEIVED=0 is expected).
  const pollStart = Date.now();
  let streamReady = false;
  while (Date.now() - pollStart < STREAM_READY_TIMEOUT_MS) {
    if (server.streamingCount > 0) {
      streamReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, STREAM_READY_POLL_MS));
  }

  // --- Baseline ---
  const { rss: baseRss, heapUsed: baseHeap } = gcThenMem();
  console.log(`BASELINE_RSS=${baseRss}`);
  console.log(`BASELINE_HEAP=${baseHeap}`);
  console.log(`STREAM_READY=${streamReady ? 1 : 0}`);

  // --- Flood ---
  // Push trade frames regardless of streaming state. If the streamer connected,
  // frames will flow through the driver's TSFN pump into on_pricing.
  // If the streamer did not connect, sent will be large but received will be 0
  // (frames reach the WS server but the Rust side never subscribed).
  let sent = 0;
  let price = 1;
  const floodStart = Date.now();

  while (Date.now() - floodStart < FLOOD_MS) {
    server.streamTradeAll("AAPL", price++);
    sent++;
    // Yield every 100 frames to let the socket flush and TSFN callbacks land.
    if (sent % 100 === 0) {
      await new Promise((r) => setImmediate(r));
    }
  }

  // --- Drain ---
  await new Promise((r) => setTimeout(r, DRAIN_MS));

  // --- Terminal ---
  const { rss: termRss, heapUsed: termHeap } = gcThenMem();
  console.log(`TERMINAL_RSS=${termRss}`);
  console.log(`TERMINAL_HEAP=${termHeap}`);
  console.log(`SENT=${sent}`);
  console.log(`RECEIVED=${received}`);

  await server.close();

  // Force-exit: the tokio host + redb keep libuv alive after stop().
  process.exit(0);
} catch (e) {
  console.log(`CHILD_ERROR ${e && e.message ? e.message : String(e)}`);
  process.exit(1);
}
