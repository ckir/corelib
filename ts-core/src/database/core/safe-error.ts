/**
 * Log-safe projection of a database error (or a driver `reason` object).
 *
 * Drivers may echo the SQL text (e.g. postgres.js attaches `query`) or bound
 * values (`detail`) on the error object, and the stack repeats the message. Error
 * logs must not carry SQL or parameter values (the redact module's contract is
 * "params OFF by default"), so only name, scalar code and the FIRST LINE of the
 * message (truncated) are kept. Note: a driver that interpolates SQL/values into
 * the first line of its message would still surface that fragment.
 */
export interface SafeDbError {
	name?: string;
	code?: string | number;
	message?: string;
}

const MAX_MESSAGE_LENGTH = 200;

export function safeDbError(e: unknown): SafeDbError {
	if (e === null || e === undefined) return {};
	if (typeof e !== "object") {
		return { message: firstLine(String(e)) };
	}
	const o = e as { name?: unknown; code?: unknown; message?: unknown };
	const out: SafeDbError = {};
	if (typeof o.name === "string") out.name = o.name;
	if (typeof o.code === "string" || typeof o.code === "number") {
		out.code = o.code;
	}
	if (typeof o.message === "string") out.message = firstLine(o.message);
	return out;
}

function firstLine(text: string): string {
	const line = text.split(/\r?\n/, 1)[0] ?? ""; // split() always yields >= 1 element
	return line.length > MAX_MESSAGE_LENGTH
		? `${line.slice(0, MAX_MESSAGE_LENGTH)}...`
		: line;
}
