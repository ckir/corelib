// =============================================
// CHILD HARNESS: soak-child.mjs
// =============================================
// Bare-node (constrained-heap) soak child for the Epic 5 memory/leak probe.
// Drives the native load generator, acking every tick (full roundtrip path),
// then force-GCs at baseline and terminal and prints post-GC memory lines for
// the parent (soak-runner.mjs) to diff. Imports the BUILT package surface
// (coreFFI = the native N-API addon), never the TS source.
//
// Requires the child be launched with --expose-gc and CORELIB_LOADGEN=1
// (the runner sets both).
//
// Output contract (one line each, parsed by the runner):
//   BASELINE_RSS=<bytes> BASELINE_HEAP=<bytes>   (after warm-up + global.gc())
//   TERMINAL_RSS=<bytes> TERMINAL_HEAP=<bytes>   (after generation + global.gc())
// On any failure: print "CHILD_ERROR <message>" and exit non-zero (the parent
// treats a non-zero/OOM exit as PROBE_CONFIRMED).
// =============================================

import { coreFFI } from "../../ts-core/dist/index.js";

function argVal(flag, def) {
	const i = process.argv.indexOf(flag);
	return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}
const rate = Number(argVal("--rate", "20000"));
const duration = Number(argVal("--duration", "90000"));
const bursty = process.argv.includes("--bursty");

if (typeof global.gc !== "function") {
	console.log("CHILD_ERROR global.gc unavailable (need --expose-gc)");
	process.exit(3);
}
if (typeof coreFFI?.napiLoadGenerator !== "function") {
	console.log("CHILD_ERROR coreFFI.napiLoadGenerator unavailable");
	process.exit(3);
}

function gcThenMem() {
	// GC twice to settle young+old gen, then read.
	global.gc();
	global.gc();
	const m = process.memoryUsage();
	return { rss: m.rss, heap: m.heapUsed };
}

async function main() {
	// WARM-UP (critical): trigger the LAZY one-time native allocations BEFORE baseline so the soak
	// delta isolates genuine per-tick marshaling leaks — NOT one-time setup. The load generator's
	// `mark_sent` lazily allocates the ~8MB latency ring (SENT_US = 1<<20 AtomicU64), and the first
	// `napiLatencyAck` allocates the samples queue. Measured AFTER baseline these look like an ~8MB
	// "leak" (Epic 5 Cluster-1 lesson). A brief warm-up run pre-allocates them into the baseline.
	await new Promise((resolve) => {
		coreFFI.napiLoadGenerator(1000, 200, false, (err, json) => {
			if (err) return;
			try {
				coreFFI.napiLatencyAck(JSON.parse(json).seq);
			} catch {
				// ignore
			}
		});
		setTimeout(resolve, 500); // let the 200ms warm-up finish + the rings allocate
	});

	const base = gcThenMem();
	console.log(`BASELINE_RSS=${base.rss} BASELINE_HEAP=${base.heap}`);

	let received = 0;
	coreFFI.napiLoadGenerator(rate, duration, bursty, (err, json) => {
		if (err) return;
		received++;
		try {
			const seq = JSON.parse(json).seq;
			coreFFI.napiLatencyAck(seq);
		} catch {
			// malformed tick should never happen; ignore for the soak
		}
	});

	// The generator runs duration_ms wall-clock on a native thread, delivering via a Blocking TSFN.
	// Wait past the deadline + slack so the queue drains, then measure terminal post-GC memory.
	setTimeout(() => {
		const term = gcThenMem();
		console.log(`TERMINAL_RSS=${term.rss} TERMINAL_HEAP=${term.heap}`);
		console.log(`RECEIVED=${received}`);
		// Native thread has ended; force-exit in case the TSFN keeps a ref.
		process.exit(0);
	}, duration + 3000);
}

main().catch((e) => {
	console.log(`CHILD_ERROR ${e && e.message ? e.message : String(e)}`);
	process.exit(1);
});
