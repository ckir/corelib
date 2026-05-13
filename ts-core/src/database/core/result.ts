import { type ErrorObject, serializeError } from "serialize-error";

/**
 * The standard Result pattern used across the database module.
 */
export type DatabaseResult<T = unknown> =
	| { status: "success"; value: T; details?: unknown }
	| {
			status: "error";
			reason: ErrorObject | { message: string; [key: string]: unknown };
	  };

/**
 * Wraps a successful value in a DatabaseResult.
 */
export const wrapSuccess = <T>(
	value: T,
	details?: unknown,
): DatabaseResult<T> => ({
	status: "success",
	value,
	details,
});

/**
 * Wraps an error in a DatabaseResult, serializing it.
 * Generic T is inferred from context so callers don't need explicit casts.
 */
export const wrapError = <T = unknown>(error: unknown): DatabaseResult<T> => ({
	status: "error",
	reason: serializeError(error),
});
