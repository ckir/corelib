// ts-core/src/loggers/common/normalize-extras.ts
// Deep, cycle-safe serialization of Error instances found anywhere in a
// logger's `extras` object. Pure: never mutates the input.
import { serializeError } from "serialize-error";

/** True for Error instances, including cross-realm errors that fail instanceof. */
function isError(value: unknown): boolean {
	return (
		value instanceof Error ||
		Object.prototype.toString.call(value) === "[object Error]"
	);
}

/** True only for plain objects (prototype Object.prototype or null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Deep-clone `extras`, replacing any Error (at any depth, inside plain objects
 * and arrays) with `serializeError()`. Non-plain objects (Date, Map, class
 * instances, etc.) are passed through by reference, untouched. Cycle-safe.
 *
 * @param extras - The caller-supplied extras (post-validate: undefined, a
 *   non-null non-array object, or — via type-bypass — an Error).
 * @returns A normalized object safe to spread into a log record, or undefined.
 */
export function normalizeExtras(
	extras: unknown,
): Record<string, unknown> | undefined {
	if (extras === undefined) return undefined;
	if (isError(extras)) {
		return { err: serializeError(extras) };
	}

	const seen = new Map<object, unknown>();
	const walk = (value: unknown): unknown => {
		if (isError(value)) return serializeError(value);

		if (Array.isArray(value)) {
			const existing = seen.get(value);
			if (existing) return existing;
			const clone: unknown[] = [];
			seen.set(value, clone);
			for (const item of value) clone.push(walk(item));
			return clone;
		}

		if (isPlainObject(value)) {
			const existing = seen.get(value);
			if (existing) return existing;
			const clone: Record<string, unknown> = {};
			seen.set(value, clone);
			for (const [k, v] of Object.entries(value)) clone[k] = walk(v);
			return clone;
		}

		return value;
	};

	return walk(extras) as Record<string, unknown>;
}
