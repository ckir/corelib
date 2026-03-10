import { type ErrorObject, serializeError } from "serialize-error";

/**
 * The standard Result pattern used across the database module.
 */
export type DatabaseResult<T = any> =
	| { status: "success"; value: T; details?: any }
	| {
			status: "error";
			reason: ErrorObject | { message: string; [key: string]: any };
	  };

/**
 * Wraps a successful value in a DatabaseResult.
 */
export const wrapSuccess = <T>(value: T, details?: any): DatabaseResult<T> => ({
	status: "success",
	value,
	details,
});

/**
 * Wraps an error in a DatabaseResult, serializing it.
 */
export const wrapError = (error: unknown): DatabaseResult<any> => ({
	status: "error",
	reason: serializeError(error),
});
