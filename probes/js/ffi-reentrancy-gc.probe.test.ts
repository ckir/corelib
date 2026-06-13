// =============================================
// PROBE: ffi-reentrancy-reconnect-gc-deadlock-01  (audit B2b)
// =============================================
// HYPOTHESIS (spec §8): under rapid subscribe/unsubscribe churn + forced
// reconnects + JS GC pressure, the Rust->JS threadsafe_function (TSFN) callback
// path (on_pricing/on_market fired NonBlocking from the alpaca pump closure) can
// DEADLOCK/STARVE the JS event loop (main thread blocked awaiting a Rust ack) or
// fire AFTER teardown and ABORT the process (callback-after-Drop / Option::unwrap
// on a torn-down handle) — a silent hang/crash that bypasses Vitest + JS
// try/catch and every logger.
//
// DESIGN: process-isolation is mandatory — a Rust abort or a TSFN deadlock must
// be OBSERVED by the parent, never allowed to kill (or hang) the vitest runner.
// The actual churn runs in a fresh child (probes/_harness/ffi-reconnect-child.mjs,
// spawned with --expose-gc) that drives the ALPACA streamer at an alpaca-aware
// loopback (probes/_harness/alpaca-loopback.mjs) via `base_url`, reaches the
// streaming state, then hammers subscribe/unsubscribe + forced reconnects +
// global.gc() for ~15s. The child emits a line protocol on stdout:
//   HEARTBEAT <n>  forward progress (PRIMARY oracle)
//   DELIVERED <n>  cumulative on_pricing TSFN deliveries (secondary oracle)
//   READY streaming=<k>
//   DONE progress=<n> delivered=<m> reconnects=<r>  then exit 0
// and installs NO panic catcher, so a Rust abort manifests as an abnormal exit
// (signal/139/134/non-zero with a panic in stderr).
//
// The parent enforces a HARD 20s ceiling and a 5s heartbeat-stall watchdog. It
// uses a UNIQUE `ALPACA_DB` redb path per spawn (the host resolves the redb path
// via unique_db_path(prefix, "ALPACA_DB"); a shared path triggers a redb
// DatabaseAlreadyOpen process-abort — see engine-redb-open-expect-abort-01 — so
// the unique path avoids a FALSE positive from an orphaned holder).
//
// ORACLE: the GOOD outcome is clean exit 0 with a rising heartbeat. This test
// ASSERTS that. If a fault reproduces (stall/ceiling => deadlock; signal/panic
// => abort), the assertion FAILS and THAT failing run is the durable repro. On
// any stall/ceiling the parent kills the child PROCESS TREE (taskkill /T /F on
// Windows) so no orphaned node/redb holder remains.
//
// Touches no production source: reads ts-core/dist + the native addon only.
// =============================================

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CHILD_REL = "probes/_harness/ffi-reconnect-child.mjs";

// Hard ceilings.
const CEILING_MS = 20_000; // absolute wall-clock cap on the child
const STALL_MS = 5_000; // max gap between HEARTBEATs before we call it a stall

type Classification =
	| "good" // exit 0 + DONE + rising heartbeat
	| "deadlock" // heartbeat stalled >STALL_MS, or ceiling hit while running
	| "abort" // signal / non-zero exit (Rust panic / callback-after-teardown)
	| "harness-error"; // NO_GC / exit 2

interface Result {
	classification: Classification;
	lastHeartbeat: number;
	delivered: number;
	reachedReady: boolean;
	doneSeen: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	detail: string;
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

function runChild(): Promise<Result> {
	return new Promise((resolveResult) => {
		// UNIQUE redb path per spawn — the host reads `ALPACA_DB`; a shared/orphaned
		// path would abort with DatabaseAlreadyOpen and masquerade as a fault.
		const dbPath = join(tmpdir(), `audit-b2b-${process.pid}-${Date.now()}.redb`);

		const child = spawn(
			process.execPath,
			["--expose-gc", CHILD_REL],
			{
				cwd: REPO_ROOT,
				env: { ...process.env, ALPACA_DB: dbPath },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let lastHeartbeat = 0;
		let delivered = 0;
		let reachedReady = false;
		let doneSeen = false;
		let noGc = false;
		let stderrBuf = "";
		let stdoutTail = "";
		let settled = false;
		let lastBeatAt = Date.now();
		// The child only prints its FIRST HEARTBEAT after ~200 churn iters (several
		// seconds in, after addon load + init/start). Stall detection must NOT run
		// before forward progress has begun, or it false-positives on the legitimate
		// startup window. Until the first HEARTBEAT, the 20s ceiling is the sole guard.
		let sawFirstBeat = false;

		let stallTimer: NodeJS.Timeout | undefined;
		let ceilingTimer: NodeJS.Timeout | undefined;

		const finish = (r: Omit<Result, "lastHeartbeat" | "delivered" | "reachedReady" | "doneSeen">) => {
			if (settled) return;
			settled = true;
			if (stallTimer) clearInterval(stallTimer);
			if (ceilingTimer) clearTimeout(ceilingTimer);
			resolveResult({
				...r,
				lastHeartbeat,
				delivered,
				reachedReady,
				doneSeen,
			});
		};

		// Heartbeat-stall watchdog: ONCE forward progress has begun (>=1 HEARTBEAT),
		// if no new HEARTBEAT arrives for STALL_MS while the child is still alive,
		// classify as a deadlock and kill the tree. Before the first heartbeat we do
		// nothing here (the 20s ceiling covers a child that never makes progress).
		stallTimer = setInterval(() => {
			if (settled) return;
			if (!sawFirstBeat) return;
			if (Date.now() - lastBeatAt > STALL_MS) {
				const pid = child.pid;
				killTree(pid);
				finish({
					classification: "deadlock",
					exitCode: null,
					signal: null,
					detail: `heartbeat stalled >${STALL_MS}ms (last HEARTBEAT ${lastHeartbeat}); killed tree pid=${pid}; stderr=${stderrBuf.slice(-300)}`,
				});
			}
		}, 1_000);

		// Absolute ceiling: hard cap regardless of heartbeat activity.
		ceilingTimer = setTimeout(() => {
			if (settled) return;
			const pid = child.pid;
			killTree(pid);
			finish({
				classification: "deadlock",
				exitCode: null,
				signal: null,
				detail: `20s ceiling hit with child still running (last HEARTBEAT ${lastHeartbeat}); killed tree pid=${pid}; stderr=${stderrBuf.slice(-300)}`,
			});
		}, CEILING_MS);

		let lineBuf = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutTail = (stdoutTail + chunk).slice(-500);
			lineBuf += chunk;
			let idx: number;
			while ((idx = lineBuf.indexOf("\n")) >= 0) {
				const line = lineBuf.slice(0, idx).trim();
				lineBuf = lineBuf.slice(idx + 1);
				if (line.length === 0) continue;
				let m: RegExpMatchArray | null;
				if ((m = line.match(/^HEARTBEAT (\d+)/))) {
					lastHeartbeat = Number(m[1]);
					lastBeatAt = Date.now();
					sawFirstBeat = true;
				} else if ((m = line.match(/^DELIVERED (\d+)/))) {
					delivered = Number(m[1]);
				} else if (line.startsWith("READY ")) {
					reachedReady = true;
				} else if (line.startsWith("DONE ")) {
					doneSeen = true;
				} else if (line === "NO_GC") {
					noGc = true;
				}
			}
		});

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderrBuf = (stderrBuf + chunk).slice(-4_000);
		});

		child.on("error", (err) => {
			finish({
				classification: "harness-error",
				exitCode: null,
				signal: null,
				detail: `spawn error: ${String(err)}`,
			});
		});

		child.on("close", (code, signal) => {
			if (settled) return;

			if (noGc || code === 2) {
				finish({
					classification: "harness-error",
					exitCode: code,
					signal,
					detail: `NO_GC / exit 2 — --expose-gc did not reach the child. stdout=${stdoutTail}`,
				});
				return;
			}

			// Abnormal exit: killed by signal, or non-zero, or a Rust panic in
			// stderr — the TSFN-after-teardown / unwrap abort vector.
			const panicked =
				/thread '.*' panicked|called `Option::unwrap\(\)`|called `Result::unwrap\(\)`|DatabaseAlreadyOpen/.test(
					stderrBuf,
				);
			const abnormal =
				signal !== null ||
				code === null ||
				(typeof code === "number" && code !== 0);

			if (abnormal || panicked) {
				finish({
					classification: "abort",
					exitCode: code,
					signal,
					detail: `abnormal child exit code=${code} signal=${signal} panicked=${panicked} stderr=${stderrBuf.slice(-400)}`,
				});
				return;
			}

			// Clean exit 0. Good only if we saw DONE and at least one heartbeat.
			if (code === 0 && doneSeen) {
				finish({
					classification: "good",
					exitCode: code,
					signal,
					detail: `clean exit; DONE seen; lastHeartbeat=${lastHeartbeat} delivered=${delivered} reachedReady=${reachedReady}`,
				});
				return;
			}

			// Exit 0 but no DONE — incomplete/odd. Surface it rather than pass.
			finish({
				classification: "abort",
				exitCode: code,
				signal,
				detail: `exit 0 but no DONE line (incomplete run); lastHeartbeat=${lastHeartbeat} stdout=${stdoutTail}`,
			});
		});
	});
}

describe("FFI reconnect-under-GC TSFN re-entrancy / deadlock (process-isolated)", () => {
	it(
		"survives subscribe/unsubscribe churn + forced reconnects + GC without hang or abort",
		async () => {
			const r = await runChild();
			// Emit raw evidence so the adjudicator can read it from the run log.
			// eslint-disable-next-line no-console
			console.log(
				`[B2b] classification=${r.classification} lastHeartbeat=${r.lastHeartbeat} delivered=${r.delivered} reachedReady=${r.reachedReady} doneSeen=${r.doneSeen} exit=${r.exitCode} signal=${r.signal} :: ${r.detail}`,
			);
			// ORACLE: forward progress + clean exit. A 'deadlock'/'abort'
			// classification IS the ffi-reentrancy-reconnect-gc-deadlock-01
			// reproduction; let the assertion fail loudly so the run is a durable
			// repro. 'harness-error' means the spawn args are wrong (fix & re-run).
			expect(r.classification, r.detail).toBe("good");
			expect(r.lastHeartbeat, "expected a rising heartbeat (forward progress)").toBeGreaterThan(0);
		},
		CEILING_MS + 10_000,
	);
});
