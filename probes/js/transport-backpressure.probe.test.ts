// =============================================
// PROBE: transport-backpressure-starved-pump  (Epic 5 Cluster-1, Task 2.2)
// =============================================
// HYPOTHESIS: with the NonBlocking TSFN cap=1024 fix (commit 1aedbcf0) in
// place, a starved JS pump + flooded trade stream results in BOUNDED native RSS
// growth (drops accepted) rather than unbounded native buffering (pre-fix
// behaviour). This is the production-path validation: real AlpacaStreaming ->
// real alpaca driver -> NonBlocking TSFN calls -> JS on_pricing.
//
// DESIGN: process-isolated child
// (probes/_harness/transport-backpressure-child.mjs). Drives a REAL
// AlpacaStreaming through the AlpacaLoopbackServer. Floods trade frames for 5 s
// while the JS consumer (on_pricing) blocks the event loop every 500th call
// (150 ms busy-spin) to starve the pump. No napiLoadGenerator, no latency ring
// — those are Task 2.1 confounds. This probe exercises the actual TSFN delivery
// path used in production.
//
// ORACLE: bounded native growth = good (NonBlocking drops, doesn't queue).
// native_growth_mb = ((termRss - termHeap) - (baseRss - baseHeap)) / 1M.
// Gate: native_growth_mb > 5 → PROBE_CONFIRMED (unbounded buffering detected).
// This test ASSERTS only that the child completed cleanly (exit 0, SENT > 0,
// no CHILD_ERROR). The PROBE_CONFIRMED / PROBE_CLEAN line is the measurement
// finding; CI stays green regardless so the finding is the observation.
//
// STREAM_READY note: in some environments the tokio timer driver does not
// advance after the first connection attempt (observed with the debug native
// build on Windows), causing the supervisor reconnect sleep to stall. The child
// reports STREAM_READY=0 in this case. If STREAM_READY=0 then RECEIVED=0 and
// native_growth_mb near 0 — the measurement is noted as partial (no TSFN
// pressure) and the run is still valid as a harness-health / crash-guard check.
//
// With the fix (NonBlocking + cap=1024, STREAM_READY=1):
//   EXPECT PROBE_CLEAN + high drop_pct (NonBlocking drops, bounded native RSS).
// Without the fix (Blocking + unbounded, STREAM_READY=1):
//   EXPECT PROBE_CONFIRMED + low drop_pct (unbounded native queue).
// If STREAM_READY=0 (environment limitation):
//   PROBE_CLEAN trivially (no load) + RECEIVED=0 + partial measurement noted.
//
// Touches no production source: reads ts-core/dist + native addon only.
// =============================================

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CHILD_REL = "probes/_harness/transport-backpressure-child.mjs";

// Hard ceiling: child runs up to 12s stream-ready poll + 5s flood + 2s drain
// + 3s safety margin. Total = 22s.
const CEILING_MS = 22_000;

interface ChildResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	baselineRss: number;
	baselineHeap: number;
	terminalRss: number;
	terminalHeap: number;
	sent: number;
	received: number;
	streamReady: boolean;
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
				env: { ...process.env },
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
			let sent = 0;
			let received = 0;
			let streamReady = false;
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
				} else if ((m = t.match(/^SENT=(\d+)/))) {
					sent = Number(m[1]);
				} else if ((m = t.match(/^RECEIVED=(\d+)/))) {
					received = Number(m[1]);
				} else if ((m = t.match(/^STREAM_READY=(\d+)/))) {
					streamReady = Number(m[1]) === 1;
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
				sent,
				received,
				streamReady,
				childError,
				stdout: stdoutBuf.slice(-2_000),
				stderr: stderrBuf.slice(-1_000),
			});
		};

		// Absolute hard ceiling: if the child doesn't finish in CEILING_MS, kill it.
		ceilingTimer = setTimeout(() => {
			if (settled) return;
			const pid = child.pid;
			killTree(pid);
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

describe("Transport backpressure — real streamer at loopback, starved pump (Cluster-1 production validation)", () => {
	it(
		"child completes without crash; emits PROBE_CONFIRMED or PROBE_CLEAN measurement",
		async () => {
			const r = await runChild();

			// Native (off-V8-heap) growth: isolates TSFN-queue / socket-buffer signal
			// from probe's own V8 churn. Formula mirrors tsfn-backpressure.probe.test.ts.
			const nativeGrowthMb =
				((r.terminalRss - r.terminalHeap) - (r.baselineRss - r.baselineHeap)) /
				(1024 * 1024);

			// V8 heap growth: probe's own object churn — reported but not gated.
			const v8GrowthMb = (r.terminalHeap - r.baselineHeap) / (1024 * 1024);

			// Drop percentage: fraction of sent frames that never reached on_pricing.
			// High drop_pct + low native growth = NonBlocking is working correctly.
			const dropPct =
				r.sent > 0 ? (1 - r.received / r.sent) * 100 : 0;

			// Machine-readable finding line for the adjudicator / CI log.
			// PROBE_CONFIRMED only if native growth > 5 MB (unbounded buffering signal).
			// If STREAM_READY=0, classify as PROBE_PARTIAL (environment limitation: no
			// TSFN pressure possible, measurement is a harness-health / crash-guard only).
			const classification =
				!r.streamReady
					? "PROBE_PARTIAL"
					: nativeGrowthMb > 5
						? "PROBE_CONFIRMED"
						: "PROBE_CLEAN";

			// eslint-disable-next-line no-console
			console.log(
				`${classification} transport-bp native_growth_mb=${nativeGrowthMb.toFixed(2)} drop_pct=${dropPct.toFixed(1)} sent=${r.sent} received=${r.received} stream_ready=${r.streamReady}`,
			);
			// eslint-disable-next-line no-console
			console.log(
				`[Cluster-1 2.2] exit=${r.exitCode} signal=${r.signal} childError=${r.childError} ` +
				`baseline_rss=${r.baselineRss} baseline_heap=${r.baselineHeap} ` +
				`terminal_rss=${r.terminalRss} terminal_heap=${r.terminalHeap} ` +
				`v8_growth_mb=${v8GrowthMb.toFixed(2)} stderr=${r.stderr.slice(-200)}`,
			);

			// ORACLE: the probe must complete without crash/hang.
			// We do NOT assert clean-vs-confirmed vs partial — that is the measurement finding.
			expect(r.childError, `child reported CHILD_ERROR: ${r.childError}`).toBeNull();
			expect(
				r.exitCode,
				`expected clean exit 0, got ${r.exitCode} signal=${r.signal} stderr=${r.stderr.slice(-200)}`,
			).toBe(0);
			expect(r.sent, "flood must have sent at least one frame").toBeGreaterThan(0);
		},
		CEILING_MS + 10_000,
	);
});
