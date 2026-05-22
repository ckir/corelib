import { type ErrorObject, serializeError } from "serialize-error";

/**
 * The standard Result pattern used across the database module to ensure safe error handling.
 * It can be either a success with a value or an error with a reason.
 *
 * @template T The type of the value on success.
 */
export type DatabaseResult<T = unknown> =
	| {
			/** Status of the operation. */
			status: "success";
			/** The result value. */
			value: T;
			/** Optional additional details about the operation. */
			details?: unknown;
	  }
	| {
			/** Status of the operation. */
			status: "error";
			/** The reason for the failure, either as a serialized error or a simple message. */
			reason: ErrorObject | { message: string; [key: string]: unknown };
	  };

/**
 * Wraps a successful value in a DatabaseResult.
 *
 * @template T The type of the value.
 * @param {T} value - The value to wrap.
 * @param {unknown} [details] - Optional additional details.
 * @returns {DatabaseResult<T>} A success DatabaseResult.
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
 * Wraps an error in a DatabaseResult, serializing it for cross-runtime safety.
 *
 * @template T The expected type of the value (will be unused since this is an error).
 * @param {unknown} error - The error to wrap.
 * @returns {DatabaseResult<T>} An error DatabaseResult.
 */
export const wrapError = <T = unknown>(error: unknown): DatabaseResult<T> => ({
	status: "error",
	reason: serializeError(error),
});
