// =============================================
// FILE: ts-core/src/database/redact.ts
// PURPOSE: Best-effort param redaction for the Flight-Recorder DB query logs.
// corelib logs query params ONLY when a project opts in by supplying a
// `paramRedactor` (params-OFF by default). This ships a reasonable default
// redactor + the array/named wiring. It is NOT a security guarantee — a short
// non-pattern secret passed as a positional value can still pass through; the
// opt-in consumer owns that residual risk (named params are caught by key).
// =============================================

import type { ParamRedactor, QueryParams } from "./core/types";

const STRING_CAP = 256; // non-secret strings longer than this are truncated
const TRUNC_KEEP = 64; // chars kept when truncating
const ARRAY_CAP = 64; // max positional params logged

/** Named-param keys whose VALUE is always masked regardless of shape (catches short secrets). */
const SECRET_KEY = /pass|secret|token|auth|key|cred/i;

// Value shapes that are almost certainly secrets.
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
const LONG_HEX = /^[0-9a-f]{32,}$/i;
const LONG_B64 = /^[A-Za-z0-9+/_=-]{40,}$/;

/**
 * Default per-value redactor. Scalars (number/boolean/bigint/null/undefined) pass through —
 * they carry forensic value (ids, equity, timestamps, flags) and are not secrets. Strings
 * that look like tokens/keys (JWT, long hex, long base64) or are very long are masked.
 * Objects/arrays are never deep-logged.
 */
export function defaultRedactor(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	const t = typeof value;
	if (t === "number" || t === "boolean" || t === "bigint") return value;
	if (t === "string") {
		const s = value as string;
		if (JWT.test(s) || LONG_HEX.test(s) || LONG_B64.test(s)) {
			return `<redacted:len=${s.length}>`;
		}
		if (s.length > STRING_CAP) {
			return `${s.slice(0, TRUNC_KEEP)}…(len=${s.length})`;
		}
		return s;
	}
	// objects / arrays / functions / symbols — never deep-log a structure.
	return "<redacted:object>";
}

/**
 * Apply `redactor` to a query's params for logging. Positional arrays are capped to the first
 * {@link ARRAY_CAP} (with a `…(+N more)` marker) and each value redacted. Named params redact
 * each value AND mask any value whose KEY looks sensitive. Returns a log-safe shape, or
 * `undefined` when there are no params.
 */
export function redactParams(
	params: QueryParams | undefined,
	redactor: ParamRedactor,
): unknown {
	if (params == null) return undefined;
	if (Array.isArray(params)) {
		const capped = params.slice(0, ARRAY_CAP).map((v) => redactor(v));
		return params.length > ARRAY_CAP
			? [...capped, `…(+${params.length - ARRAY_CAP} more)`]
			: capped;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(params)) {
		out[k] = SECRET_KEY.test(k) ? "<redacted:key>" : redactor(v);
	}
	return out;
}
