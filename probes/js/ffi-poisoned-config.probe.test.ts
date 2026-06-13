// =============================================
// PROBE: ffi-poisoned-config-panic-01  (audit B2a)
// =============================================
// HYPOTHESIS (agy Phase-B highest-priority target): the boot-layer config
// races (boot-ConfigManager-initialize-races-01 / -partial-init-window-02 /
// -loadExternalConfig-concurrent-05, all `affected:["ffi"]`) mean
// undefined/malformed/empty config values can reach the JS->Rust N-API
// boundary. IF the Rust side `.unwrap()`s / panics on such input, the panic
// ABORTS the whole Node/Bun process (139/134/101/127), bypassing every JS
// try/catch and logger — a silent crash. Question: does poisoned/edge-case
// input across the FFI boundary cause a process-aborting panic (or hang), or
// does Rust surface a catchable napi::Error to JS?
//
// OBSERVED (this probe, on a freshly-built addon): the N-API boundary handles
// EVERY poison case GRACEFULLY. napi's automatic argument marshalling rejects
// undefined/null/wrong-type/oversized inputs as catchable JS errors (or
// accepts them as valid) BEFORE any Rust `.unwrap()` can fire — for the
// three #[napi] streamer facades (Alpaca/Yahoo/Finnhub) constructors,
// init(config), and subscribe(...). No case aborts the host process; no case
// hangs. The only reachable `.expect()` on the Rust side
// (host.rs:57 `Database::create(..).expect("Failed to open redb")`) is driven
// by an env/filesystem path, NOT by JS-supplied config, so it is out of reach
// of this input-poisoning vector.
//
// This is a POSITIVE result: the FFI *input* boundary is robust. The probe is
// kept as a durable regression guard — if a future change adds an `.unwrap()`
// on JS-reachable config and a case starts aborting the child, this test flips
// to red.
//
// DESIGN: process-isolation is mandatory — a panic/abort or deadlock must be
// OBSERVED, never allowed to kill the vitest runner. Each case runs in a fresh
// child (probes/_harness/ffi-poison-child.mjs) via spawnSync with a 5s timeout;
// we classify the child by exit code + stdout. Bounded: 22 cases, each a single
// FFI invocation, well under the 20s budget.
//
// Reads/constructs only; no network. Touches no production config or source.
// =============================================

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(__dirname, "..", "_harness", "ffi-poison-child.mjs");

// COMPLETE poison-case list (no elision). Each maps to a real String/Vec<String>
// /ThreadsafeFunction param on the Rust side that a JS caller could feed bad input.
const CASES = [
	// constructor: required ThreadsafeFunction callbacks
	"alpaca-ctor-no-args",
	"alpaca-ctor-null-callbacks",
	"alpaca-ctor-wrong-type-callbacks",
	// AlpacaConfig via init(): Option<String>/Option<u32> fields
	"alpaca-init-null",
	"alpaca-init-undefined",
	"alpaca-init-keyid-number",
	"alpaca-init-silence-string",
	"alpaca-init-base-url-null",
	// AlpacaSubscribeOpts: Option<Vec<String>> channels
	"alpaca-subscribe-undefined",
	"alpaca-subscribe-null",
	"alpaca-subscribe-channel-null-element",
	"alpaca-subscribe-channel-number-element",
	// Yahoo: subscribe(symbols: Vec<String>)
	"yahoo-subscribe-undefined",
	"yahoo-subscribe-null",
	"yahoo-subscribe-null-element",
	"yahoo-subscribe-number-element",
	"yahoo-subscribe-string-not-array",
	"yahoo-subscribe-oversized-element",
	// Finnhub: FinnhubConfig.token (Option<String>) + Vec<String>
	"finnhub-init-null",
	"finnhub-init-token-number",
	"finnhub-subscribe-null-element",
	"finnhub-subscribe-undefined",
] as const;

type Outcome =
	| { kind: "graceful"; detail: string }
	| { kind: "abort"; detail: string }
	| { kind: "hang"; detail: string };

function classify(id: string): Outcome {
	const r = spawnSync(process.execPath, [CHILD, id], {
		encoding: "utf8",
		timeout: 5000,
	});
	const stdout = (r.stdout ?? "").trim();
	const stderr = (r.stderr ?? "").trim();

	// timeout => no exit within 5s => FFI hang/deadlock
	if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
		return { kind: "hang", detail: `timeout; stdout=${stdout}` };
	}

	const panicked = /thread '.*' panicked|called `Option::unwrap\(\)`|called `Result::unwrap\(\)`/.test(
		stderr,
	);
	// Process-aborting panic across FFI: abnormal exit and/or a Rust panic line,
	// and the child never reached its CASE...OK/CAUGHT print (exit 0).
	const abnormal =
		r.status === null || // killed by signal (SIGSEGV/SIGABRT)
		r.status === 139 ||
		r.status === 134 ||
		r.status === 101 ||
		r.status === 127;

	if (panicked || abnormal) {
		return {
			kind: "abort",
			detail: `status=${r.status} signal=${r.signal} panicked=${panicked} stderr=${stderr.slice(0, 200)}`,
		};
	}

	// Graceful: child printed CASE <id> CAUGHT/OK and exited 0.
	if (r.status === 0 && /^CASE .* (CAUGHT|OK)/m.test(stdout)) {
		return { kind: "graceful", detail: stdout };
	}

	// Anything else (unknown id exit 2, non-zero without a panic) — treat as a
	// failure signal so it surfaces rather than passing silently.
	return {
		kind: "abort",
		detail: `unexpected status=${r.status} stdout=${stdout} stderr=${stderr.slice(0, 200)}`,
	};
}

describe("FFI poisoned-config panic boundary (process-isolated)", () => {
	for (const id of CASES) {
		it(`handles poison case '${id}' without aborting the host process`, () => {
			const outcome = classify(id);
			// ORACLE: a robust napi boundary turns every poison input into a
			// catchable error (or accepts it) — the child survives and exits 0.
			// If this assertion fails with kind 'abort'/'hang', that IS the
			// ffi-poisoned-config-panic-01 reproduction (a Rust panic/deadlock
			// crossing FFI on JS-reachable input) — escalate the finding.
			expect(
				outcome.kind,
				`case '${id}' did not survive gracefully: ${outcome.detail}`,
			).toBe("graceful");
		});
	}
});
