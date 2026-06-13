// =============================================
// CHILD HARNESS: ffi-poison-child.mjs
// =============================================
// Process-isolated worker for the FFI poisoned-config panic probe
// (audit B2a). Takes ONE poison-case id via argv, imports the PUBLIC
// package surface (@ckir/corelib -> coreFFI, the native N-API addon),
// constructs the relevant streamer, and invokes ONE entry point with
// ONE poisoned input.
//
// Contract (the driver classifies the child by exit code + stdout):
//   * a CAUGHT JS error  -> print "CASE <id> CAUGHT <message>", exit 0
//   * completes w/o error -> print "CASE <id> OK",              exit 0
//   * a Rust panic across the FFI boundary aborts the process BEFORE
//     we can print/exit -> the child dies with a non-zero/abnormal exit
//     (139/134/101/127) and a `thread '...' panicked` line on stderr.
//     We deliberately do NOT install a panic catcher — a process-abort
//     MUST manifest as an abnormal child exit, never be swallowed.
//
// Why import from ts-core/dist (the built @ckir/corelib) rather than the
// raw rust/index.js: the hypothesis is about poisoned config reaching the
// boundary *through the public package*, so we exercise the exact module
// JS consumers load (coreFFI = await loadFFI()).
// =============================================

import { coreFFI } from "../../ts-core/dist/index.js";

const noop = () => {};
const id = process.argv[2];

// Each case is a thunk that performs exactly ONE poisoned FFI invocation.
// Constructors require 3 valid ThreadsafeFunction callbacks; the poison is
// applied to the specific argument/field under test.
const CASES = {
	// ── constructor: required ThreadsafeFunction args ────────────────────
	"alpaca-ctor-no-args": async () => {
		new coreFFI.AlpacaStreaming();
	},
	"alpaca-ctor-null-callbacks": async () => {
		new coreFFI.AlpacaStreaming(null, null, null);
	},
	"alpaca-ctor-wrong-type-callbacks": async () => {
		new coreFFI.AlpacaStreaming(42, "x", {});
	},

	// ── AlpacaConfig via init(): Option<String>/Option<u32> fields ───────
	"alpaca-init-null": async () => {
		const a = new coreFFI.AlpacaStreaming(noop, noop, noop);
		await a.init(null);
	},
	"alpaca-init-undefined": async () => {
		const a = new coreFFI.AlpacaStreaming(noop, noop, noop);
		await a.init(undefined);
	},
	"alpaca-init-keyid-number": async () => {
		const a = new coreFFI.AlpacaStreaming(noop, noop, noop);
		await a.init({ key_id: 42 });
	},
	"alpaca-init-silence-string": async () => {
		const a = new coreFFI.AlpacaStreaming(noop, noop, noop);
		await a.init({ silence_seconds: "x" });
	},
	"alpaca-init-base-url-null": async () => {
		const a = new coreFFI.AlpacaStreaming(noop, noop, noop);
		await a.init({ base_url: null });
	},

	// ── AlpacaSubscribeOpts (object with Option<Vec<String>> channels) ───
	"alpaca-subscribe-undefined": async () => {
		const a = new coreFFI.AlpacaStreaming(noop, noop, noop);
		await a.init({});
		await a.subscribe(undefined);
	},
	"alpaca-subscribe-null": async () => {
		const a = new coreFFI.AlpacaStreaming(noop, noop, noop);
		await a.init({});
		await a.subscribe(null);
	},
	"alpaca-subscribe-channel-null-element": async () => {
		const a = new coreFFI.AlpacaStreaming(noop, noop, noop);
		await a.init({});
		await a.subscribe({ trades: [null] });
	},
	"alpaca-subscribe-channel-number-element": async () => {
		const a = new coreFFI.AlpacaStreaming(noop, noop, noop);
		await a.init({});
		await a.subscribe({ trades: [42] });
	},

	// ── Yahoo: subscribe(symbols: Vec<String>) — required array ──────────
	"yahoo-subscribe-undefined": async () => {
		const y = new coreFFI.YahooStreaming(noop, noop, noop);
		await y.subscribe(undefined);
	},
	"yahoo-subscribe-null": async () => {
		const y = new coreFFI.YahooStreaming(noop, noop, noop);
		await y.subscribe(null);
	},
	"yahoo-subscribe-null-element": async () => {
		const y = new coreFFI.YahooStreaming(noop, noop, noop);
		await y.subscribe([null]);
	},
	"yahoo-subscribe-number-element": async () => {
		const y = new coreFFI.YahooStreaming(noop, noop, noop);
		await y.subscribe([42]);
	},
	"yahoo-subscribe-string-not-array": async () => {
		const y = new coreFFI.YahooStreaming(noop, noop, noop);
		await y.subscribe("AAPL");
	},
	"yahoo-subscribe-oversized-element": async () => {
		const y = new coreFFI.YahooStreaming(noop, noop, noop);
		await y.subscribe(["A".repeat(2_000_000)]);
	},

	// ── Finnhub: FinnhubConfig.token (Option<String>) + Vec<String> ──────
	"finnhub-init-null": async () => {
		const f = new coreFFI.FinnhubStreaming(noop, noop, noop);
		await f.init(null);
	},
	"finnhub-init-token-number": async () => {
		const f = new coreFFI.FinnhubStreaming(noop, noop, noop);
		await f.init({ token: 42 });
	},
	"finnhub-subscribe-null-element": async () => {
		const f = new coreFFI.FinnhubStreaming(noop, noop, noop);
		await f.subscribe([null]);
	},
	"finnhub-subscribe-undefined": async () => {
		const f = new coreFFI.FinnhubStreaming(noop, noop, noop);
		await f.subscribe(undefined);
	},
};

const run = CASES[id];
if (!run) {
	// Unknown id is a harness error, not a probe outcome — distinct exit.
	console.log(`CASE ${id} UNKNOWN`);
	process.exit(2);
}

try {
	await run();
	console.log(`CASE ${id} OK`);
} catch (e) {
	console.log(`CASE ${id} CAUGHT ${e && e.message ? e.message : String(e)}`);
}
// Streamers keep the libuv loop alive (tokio host + redb handle), so we MUST
// force-exit after classifying; otherwise the child would hang and the driver
// would mis-classify a graceful case as a deadlock.
process.exit(0);
