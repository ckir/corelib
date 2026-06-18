// =============================================
// FILE: ts-core/src/utils/flight-recorder.ts
// PURPOSE: Shared primitives for "Flight-Recorder" TRACE logging — the AI-only
// diagnostic tier (TRACE must let an AI spot bugs from logs alone). A single
// process-wide correlation id pairs an operation's start with its terminus
// across every corelib package, and a typed extras shape keeps field names
// consistent so AI grep/regex stays reliable.
// =============================================

let _cid = 0;

/**
 * Returns the next process-wide monotonic correlation id. Used to pair a
 * flight-recorder operation's start line (e.g. `query: exec`, `poll: start`)
 * with its terminus (`query: ok` / `poll: done` / `*: error`). Cheap (one int++),
 * globally unique across all corelib packages so two interleaved operations
 * never share an id. For cross-operation tracing, pair this with a higher-level
 * `traceId` threaded by the consuming application.
 */
export function nextCid(): number {
	return ++_cid;
}

/**
 * Core, strictly-typed flight-recorder extras. The named fields are fixed so an
 * AI can grep them reliably; arbitrary extra keys carry domain detail.
 */
export interface FlightRecorderExtras {
	/** Correlation id pairing an operation's start with its terminus. */
	cid?: number | string;
	/** Wall-clock duration of the operation, in milliseconds (set on the terminus line). */
	durationMs?: number;
	/** What initiated the operation (cron name, route, event) — lets an AI trace up the stack. */
	trigger?: string;
	/** Domain-specific detail (symbol, account, counts, sample, errorMsg, …). */
	[key: string]: unknown;
}
