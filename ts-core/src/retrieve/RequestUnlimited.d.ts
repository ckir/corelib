import { type Options as KyOptions } from "ky";
import { type ErrorObject } from "serialize-error";
import { type SerializedResponse } from "./RequestResponseSerialize";
/**
 * Discriminated union for request results, ensuring type-safe success/error handling.
 * @template T - The expected response body type.
 */
export type RequestResult<T = unknown> =
	| {
			status: "success";
			value: SerializedResponse<T>;
	  }
	| {
			status: "error";
			reason: SerializedResponse<T> | ErrorObject;
	  };
/**
 * Default configuration for ky requests, including retry logic and hooks.
 */
export declare const DEFAULT_REQUEST_OPTIONS: KyOptions;
/**
 * Makes an HTTP request to a single URL with resilience features.
 * @param url - The URL or Request object to fetch.
 * @param options - Optional ky configuration to override defaults.
 * @returns A Promise resolving to the RequestResult (success or error).
 * @template T - The expected response body type.
 */
export declare function endPoint<T = unknown>(
	url: string | URL | Request,
	options?: KyOptions,
): Promise<RequestResult<T>>;
/**
 * Makes parallel HTTP requests to multiple URLs.
 * @param urls - Array of URLs or Request objects to fetch.
 * @param options - Optional ky configuration to apply to all requests.
 * @returns A Promise resolving to an array of RequestResults (in input order).
 * @template T - The expected response body type for each request.
 */
export declare function endPoints<T = unknown>(
	urls: (string | URL | Request)[],
	options?: KyOptions,
): Promise<RequestResult<T>[]>;
/**
 * @deprecated Use endPoint/endPoints functions directly.
 */
export declare const RequestUnlimited: {
	defaults: KyOptions;
	endPoint: typeof endPoint;
	endPoints: typeof endPoints;
};
