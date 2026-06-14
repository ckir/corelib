// =============================================
// PARENT HARNESS: soak-runner.mjs
// =============================================
// Spawns soak-child.mjs in a CONSTRAINED-heap bare-node process
// (--max-old-space-size=128 --expose-gc) with CORELIB_LOADGEN=1, parses the
// child's post-GC BASELINE/TERMINAL memory lines, and computes ABSOLUTE
// post-GC deltas (NOT hourly extrapolation). Emits the spec hard-gate verdict:
//
//   PROBE_CONFIRMED soak heap_delta=<MB> rss_delta=<MB>   (leak/growth)
//     when post-GC V8 heap delta >= 1 MB OR RSS delta >= 5 MB OR child OOM/crash
//   PROBE_CLEAN soak heap_delta=<MB> rss_delta=<MB>       (otherwise)
//
// Usage: node probes/_harness/soak-runner.mjs --rate 20000 --duration 90000 [--bursty]
// =============================================

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MB = 1024 * 1024;
const HEAP_GATE_MB = 1; // spec: post-GC V8 heap delta >= 1 MB
const RSS_GATE_MB = 5; // spec: native RSS delta >= 5 MB

function argVal(flag, def) {
	const i = process.argv.indexOf(flag);
	return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}
const rate = argVal("--rate", "20000");
const duration = argVal("--duration", "90000");
const bursty = process.argv.includes("--bursty");

const childPath = fileURLToPath(new URL("./soak-child.mjs", import.meta.url));
const childArgs = [
	"--max-old-space-size=128",
	"--expose-gc",
	childPath,
	"--rate",
	String(rate),
	"--duration",
	String(duration),
];
if (bursty) childArgs.push("--bursty");

const child = spawn(process.execPath, childArgs, {
	env: { ...process.env, CORELIB_LOADGEN: "1" },
	stdio: ["ignore", "pipe", "inherit"],
});

let out = "";
child.stdout.on("data", (d) => {
	const s = d.toString();
	out += s;
	process.stdout.write(s); // echo child lines for CI logs
});

function num(re) {
	const m = out.match(re);
	return m ? Number(m[1]) : null;
}

child.on("close", (code) => {
	const baseRss = num(/BASELINE_RSS=(\d+)/);
	const baseHeap = num(/BASELINE_HEAP=(\d+)/);
	const termRss = num(/TERMINAL_RSS=(\d+)/);
	const termHeap = num(/TERMINAL_HEAP=(\d+)/);

	const crashed =
		code !== 0 || baseRss == null || termRss == null || baseHeap == null || termHeap == null;

	const heapDeltaMb = crashed ? NaN : (termHeap - baseHeap) / MB;
	const rssDeltaMb = crashed ? NaN : (termRss - baseRss) / MB;

	const confirmed =
		crashed || heapDeltaMb >= HEAP_GATE_MB || rssDeltaMb >= RSS_GATE_MB;

	const verdict = confirmed ? "PROBE_CONFIRMED" : "PROBE_CLEAN";
	const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : "NaN");
	console.log(
		`${verdict} soak heap_delta=${fmt(heapDeltaMb)} rss_delta=${fmt(rssDeltaMb)}${crashed ? ` child_exit=${code}` : ""}`,
	);
	// Always exit 0: the verdict is in the RESULT line, not the exit code
	// (the CI wrapper greps for PROBE_CONFIRMED).
	process.exit(0);
});
