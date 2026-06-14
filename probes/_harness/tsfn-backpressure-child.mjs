// =============================================
// CHILD HARNESS: tsfn-backpressure-child.mjs  (Epic 5 Cluster-1)
// =============================================
// Process-isolated worker for the TSFN queue backpressure probe.
// MUST be run with `--expose-gc` and env CORELIB_LOADGEN=1.
//
// Hypothesis (Cluster 1): the streaming TSFNs are created unbounded
// (napi default max_queue_size=0). Under a blocked JS event loop the native
// Blocking TSFN calls queue off-heap without bound, causing native RSS to
// grow proportionally to the outstanding call count.
//
// Design: start napiLoadGenerator at 20 000 ticks/sec for 5 s (steady mode).
// In the callback, every 500th tick busy-spin 150 ms to simulate a blocked
// event loop — this causes the Blocking generator thread to queue up inside
// the TSFN while the loop is stalled. A setInterval every 250 ms samples
// RSS so we capture the peak, not just the terminal value.
//
// Output contract (parsed by the parent):
//   BASELINE_RSS=<bytes>
//   PEAK_RSS_DURING=<bytes>
//   TERMINAL_RSS=<bytes>
//   RECEIVED=<n>
//   MAXSEQ=<n>
// On any failure: CHILD_ERROR <msg> + exit non-zero.
// =============================================

import { coreFFI } from "../../ts-core/dist/index.js";

if (typeof global.gc !== "function") {
  console.log("CHILD_ERROR global.gc unavailable (need --expose-gc)");
  process.exit(3);
}

if (typeof coreFFI?.napiLoadGenerator !== "function") {
  console.log("CHILD_ERROR coreFFI.napiLoadGenerator unavailable (need CORELIB_LOADGEN=1 and built addon)");
  process.exit(3);
}

const RATE = 20_000;       // ticks/sec
const DURATION_MS = 5_000; // run window
const SAMPLE_INTERVAL_MS = 250;

try {
  // Baseline: two GC passes to settle old+young gen.
  global.gc();
  global.gc();
  const baselineRss = process.memoryUsage().rss;
  console.log(`BASELINE_RSS=${baselineRss}`);

  let received = 0;
  let maxSeq = 0;
  let peakRssDuring = baselineRss;

  // RSS sampler — runs independently of the callback loop.
  const samplerInterval = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssDuring) peakRssDuring = rss;
  }, SAMPLE_INTERVAL_MS);

  // Start the native load generator. It runs on a native thread for DURATION_MS
  // then exits the loop. The Blocking TSFN call mode means the native thread
  // BLOCKS when the JS queue is full — but with max_queue_size=0 (unbounded) it
  // never blocks, so outstanding calls pile up off-heap.
  coreFFI.napiLoadGenerator(RATE, DURATION_MS, false, (err, json) => {
    if (err) return;
    received++;
    try {
      const seq = JSON.parse(json).seq;
      if (seq > maxSeq) maxSeq = seq;
      coreFFI.napiLatencyAck(seq);
    } catch {
      // malformed tick — ignore
    }

    // Simulate a blocked event loop every 500 callbacks: busy-spin 150 ms.
    // This causes the Blocking native thread to queue further calls off-heap
    // while the JS loop is stalled — exercising the unbounded queue hypothesis.
    if (received % 500 === 0) {
      const spinEnd = Date.now() + 150;
      while (Date.now() < spinEnd) { /* busy wait */ }
    }
  });

  // After DURATION_MS + 2 s slack (for queue drain + final callbacks), finalise.
  setTimeout(() => {
    clearInterval(samplerInterval);
    global.gc();
    global.gc();
    const terminalRss = process.memoryUsage().rss;
    console.log(`TERMINAL_RSS=${terminalRss}`);
    console.log(`PEAK_RSS_DURING=${peakRssDuring}`);
    console.log(`RECEIVED=${received}`);
    console.log(`MAXSEQ=${maxSeq}`);
    process.exit(0);
  }, DURATION_MS + 2_000);
} catch (e) {
  console.log(`CHILD_ERROR ${e && e.message ? e.message : String(e)}`);
  process.exit(1);
}
