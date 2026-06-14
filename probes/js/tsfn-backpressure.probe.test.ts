// =============================================
// PROBE: ffi-tsfn-queue-unbounded-01  (Epic 5 Cluster-1)
// =============================================
// HYPOTHESIS: the streaming ThreadsafeFunctions (on_log, on_pricing,
// on_event, on_market_event in alpaca/yahoo/finnhub_streamer.rs) are created
// with no max_queue_size set, so napi-rs defaults to 0 = unbounded queue.
// When the JS event loop is blocked the native Blocking TSFN thread cannot
// deliver and all outstanding calls accumulate off-heap without any back-
// pressure signal or cap. Under sustained load + a stalled loop, native RSS
// therefore grows in proportion to the in-flight call count.
//
// DESIGN: process-isolated child (probes/_harness/tsfn-backpressure-child.mjs)
// driven by the in-process napiLoadGenerator at 20 000 ticks/sec for 5 s
// (no socket, no streamer — exercises the same TSFN delivery path via the
// same Blocking call mode). The child busy-spins 150 ms every 500 callbacks
// to simulate a stalled event loop. An in-child setInterval samples native
// RSS every 250 ms so peak — not just terminal — growth is captured.
//
// ORACLE: the GOOD outcome is bounded native RSS growth (the system stays
// healthy under load). This test ASSERTS only that the child completed
// without crash or hang (RECEIVED > 0, exit 0, no CHILD_ERROR). The
// PROBE_CONFIRMED / PROBE_CLEAN classification is printed as a machine line
// for the adjudicator; CI stays green regardless so the finding is the
// measurement, not a test failure.
//
// Memory model: total RSS includes the V8 heap. This probe isolates NATIVE
// off-V8-heap growth (the unbounded-TSFN signal) via rss - heapUsed. V8
// growth is the probe's own JSON.parse / napiLatencyAck churn and is
// reported but NOT gated. Hard gate: nativeGrowthMb > 5 → PROBE_CONFIRMED.
//
// Touches no production source: reads ts-core/dist + the native addon only.
// =============================================

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CHILD_REL = "probes/_harness/tsfn-backpressure-child.mjs";

// Hard ceiling: child runs 5 s + 2 s slack + 5 s safety margin.
const CEILING_MS = 20_000;

interface ChildResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	baselineRss: number;
	baselineHeap: number;
	terminalRss: number;
	terminalHeap: number;
	peakRssDuring: number;
	received: number;
	maxSeq: number;
	childError: string | null;
	stdout: string;
	stderr: string;
}

function killTree(pid: number | undefined): void {
	if (pid === undefined) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
		});
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}
}

function runChild(): Promise<ChildResult> {
	return new Promise((resolveResult) => {
		const child = spawn(
			process.execPath,
			["--expose-gc", CHILD_REL],
			{
				cwd: REPO_ROOT,
				env: { ...process.env, CORELIB_LOADGEN: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stdoutBuf = "";
		let stderrBuf = "";
		let settled = false;

		let ceilingTimer: NodeJS.Timeout | undefined;

		const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			if (ceilingTimer) clearTimeout(ceilingTimer);

			// Parse output lines.
			let baselineRss = 0;
			let baselineHeap = 0;
			let terminalRss = 0;
			let terminalHeap = 0;
			let peakRssDuring = 0;
			let received = 0;
			let maxSeq = 0;
			let childError: string | null = null;

			for (const line of stdoutBuf.split("\n")) {
				const t = line.trim();
				let m: RegExpMatchArray | null;
				if ((m = t.match(/^BASELINE_RSS=(\d+)/))) {
					baselineRss = Number(m[1]);
				} else if ((m = t.match(/^BASELINE_HEAP=(\d+)/))) {
					baselineHeap = Number(m[1]);
				} else if ((m = t.match(/^TERMINAL_RSS=(\d+)/))) {
					terminalRss = Number(m[1]);
				} else if ((m = t.match(/^TERMINAL_HEAP=(\d+)/))) {
					terminalHeap = Number(m[1]);
				} else if ((m = t.match(/^PEAK_RSS_DURING=(\d+)/))) {
					peakRssDuring = Number(m[1]);
				} else if ((m = t.match(/^RECEIVED=(\d+)/))) {
					received = Number(m[1]);
				} else if ((m = t.match(/^MAXSEQ=(\d+)/))) {
					maxSeq = Number(m[1]);
				} else if ((m = t.match(/^CHILD_ERROR (.+)/))) {
					childError = m[1];
				}
			}

			resolveResult({
				exitCode,
				signal,
				baselineRss,
				baselineHeap,
				terminalRss,
				terminalHeap,
				peakRssDuring,
				received,
				maxSeq,
				childError,
				stdout: stdoutBuf.slice(-1_000),
				stderr: stderrBuf.slice(-1_000),
			});
		};

		// Absolute hard ceiling: if the child doesn't finish in CEILING_MS, kill it.
		ceilingTimer = setTimeout(() => {
			if (settled) return;
			const pid = child.pid;
			killTree(pid);
			// Force settlement with what we have.
			finish(null, null);
		}, CEILING_MS);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutBuf += chunk;
		});

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderrBuf = (stderrBuf + chunk).slice(-4_000);
		});

		child.on("error", (err) => {
			stderrBuf += `\nspawn-error: ${String(err)}`;
			finish(null, null);
		});

		child.on("close", (code, signal) => {
			finish(code, signal as NodeJS.Signals | null);
		});
	});
}

describe("TSFN queue backpressure under blocked event loop (process-isolated)", () => {
	it(
		"child completes without crash; emits PROBE_CONFIRMED or PROBE_CLEAN measurement",
		async () => {
			const r = await runChild();

			const peakGrowthMB = (r.peakRssDuring - r.baselineRss) / (1024 * 1024);
			// Native (off-V8-heap) growth: isolates TSFN-queue signal from probe's own V8 churn.
			const nativeGrowthMb = ((r.terminalRss - r.terminalHeap) - (r.baselineRss - r.baselineHeap)) / (1024 * 1024);
			// V8 heap growth: probe's own JSON.parse/napiLatencyAck churn — reported but not gated.
			const v8GrowthMb = (r.terminalHeap - r.baselineHeap) / (1024 * 1024);

			// Machine-readable finding line for the adjudicator / CI log.
			const classification = nativeGrowthMb > 5 ? "PROBE_CONFIRMED" : "PROBE_CLEAN";
			// eslint-disable-next-line no-console
			console.log(
				`${classification} tsfn-queue native_growth_mb=${nativeGrowthMb.toFixed(2)} v8_growth_mb=${v8GrowthMb.toFixed(2)} received=${r.received}`,
			);
			// eslint-disable-next-line no-console
			console.log(
				`[Cluster-1] exit=${r.exitCode} signal=${r.signal} childError=${r.childError} baseline_rss=${r.baselineRss} baseline_heap=${r.baselineHeap} peak_rss=${r.peakRssDuring} terminal_rss=${r.terminalRss} terminal_heap=${r.terminalHeap} peak_growth_mb=${peakGrowthMB.toFixed(2)} stderr=${r.stderr.slice(-200)}`,
			);

			// ORACLE: the probe must complete without crash/hang.
			// We do NOT assert clean-vs-confirmed — that is recorded as a finding.
			expect(r.childError, `child reported CHILD_ERROR: ${r.childError}`).toBeNull();
			expect(r.exitCode, `expected clean exit 0, got ${r.exitCode} signal=${r.signal} stderr=${r.stderr.slice(-200)}`).toBe(0);
			expect(r.received, "load generator must have delivered at least one tick").toBeGreaterThan(0);
		},
		CEILING_MS + 10_000,
	);
});
