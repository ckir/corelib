// =============================================
// FILE: ts-core/src/retrieve/RequestUnlimited.ts
// PURPOSE: High-resilience HTTP request utility using ky for requests with retries, error handling, and serialization.
// Supports single or parallel requests with discriminated union results for safe typing.
// =============================================

import { deepmergeCustom } from "deepmerge-ts";
import ky, { HTTPError, type Options as KyOptions } from "ky";
import { type ErrorObject, serializeError } from "serialize-error";
import { ConfigManager } from "../configs";
import logger from "../loggers";
import { nextCid } from "../utils/flight-recorder";
import {
	type SerializedResponse,
	serializeResponse,
} from "./RequestResponseSerialize.js";

const requestUnlimitedLogger = logger.child({ section: "RequestUnlimited" });

/**
 * Custom deepmerge instance that overwrites arrays instead of merging them.
 * This matches the previous ts-deepmerge { mergeArrays: false } behavior.
 */
const customDeepmerge = deepmergeCustom({
	mergeArrays: false,
});

export const MAX_RETRY_LIMIT = 10;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 120000;
export const MAX_BACKOFF_LIMIT_MS = 60000;

/** Map any non-finite/non-number/out-of-range input to a safe value in [min,max]. */
export function clampNumber(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

/**
 * Redaction-safe URL for logging: returns origin + pathname only, stripping
 * query params and inline credentials (which may carry tokens/keys/passwords).
 * Never echoes the raw input (avoids leaking secrets on parse failure).
 */
function safeUrl(u: string | URL | Request): string {
	try {
		const parsed =
			u instanceof URL ? u : new URL(u instanceof Request ? u.url : u);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "[unparseable url]";
	}
}

/** Full-Jitter backoff: uniform in [0, min(backoffLimit, 300*2^(attempt-1))]. */
export function fullJitterDelay(attempt: number, backoffLimit: number): number {
	const base = Math.min(backoffLimit, 300 * 2 ** (attempt - 1));
	const delayMs = Math.round(Math.random() * base);
	requestUnlimitedLogger.trace("retry delay computed", {
		attempt,
		base,
		cap: backoffLimit,
		delayMs,
	});
	return delayMs;
}

/**
 * Discriminated union for request results, ensuring type-safe success/error handling.
 * @template T - The expected response body type.
 */
export type RequestResult<T = unknown> =
	| { status: "success"; value: SerializedResponse<T> }
	| { status: "error"; reason: SerializedResponse<T> | ErrorObject };

/**
 * Default configuration for ky requests, including retry logic and hooks.
 */
export const DEFAULT_REQUEST_OPTIONS: KyOptions = {
	timeout: 50000,
	throwHttpErrors: true,
	retry: {
		limit: 5,
		methods: ["get", "post", "put", "delete", "patch"],
		backoffLimit: 3000,
		shouldRetry: ({ error, retryCount }) => {
			if (error instanceof HTTPError && error.response) {
				const status = error.response.status;
				if (status === 429 && retryCount <= 5) {
					requestUnlimitedLogger.trace("retry decision", {
						status,
						willRetry: true,
					});
					return true;
				}
				if (status >= 400 && status < 500) {
					requestUnlimitedLogger.trace("retry decision: skip", {
						status,
						willRetry: false,
					});
					return false;
				}
				const willRetry = status >= 500;
				requestUnlimitedLogger.trace(
					willRetry ? "retry decision" : "retry decision: skip",
					{ status, willRetry },
				);
				return willRetry;
			}
			requestUnlimitedLogger.trace("retry decision", { willRetry: true });
			return true;
		},
	},
	method: "get",
	headers: {
		"content-type": "application/json",
		accept: "application/json",
	},
	hooks: {
		// Retry logging is done per-call in endPoint() so it can carry the request's cid;
		// a module-level default hook here has no access to that per-call correlation id.
		beforeRetry: [],
	},
};

/**
 * Internal utility to normalize header keys to lowercase for consistency.
 * @param obj - The headers object to normalize.
 * @returns Normalized headers with lowercase keys.
 */
function toLowercaseKeys(
	obj: Record<string, string | undefined>,
): Record<string, string> {
	const newObj: Record<string, string> = {};
	for (const key in obj) {
		if (Object.hasOwn(obj, key) && obj[key] !== undefined) {
			newObj[key.toLowerCase()] = obj[key] as string;
		}
	}
	return newObj;
}

/**
 * Makes an HTTP request to a single URL with resilience features.
 * @param url - The URL or Request object to fetch.
 * @param options - Optional ky configuration to override defaults.
 * @returns A Promise resolving to the RequestResult (success or error).
 * @template T - The expected response body type.
 */
export async function endPoint<T = unknown>(
	url: string | URL | Request,
	options: KyOptions = {},
): Promise<RequestResult<T>> {
	// 1. Normalize headers
	const normalizedDefaultHeaders = toLowercaseKeys(
		(DEFAULT_REQUEST_OPTIONS.headers || {}) as Record<string, string>,
	);

	const normalizedInputHeaders = options.headers
		? toLowercaseKeys(options.headers as Record<string, string>)
		: {};

	// 2. Separate headers and hooks from options to handle them manually
	const { headers, hooks, ...remainingOptions } = options;

	// 3. Read config-driven overrides (fall back to hardcoded defaults when ConfigManager is not initialized)
	// Floor at MIN_TIMEOUT_MS: a poisoned `0` would otherwise disable ky's timeout entirely
	// (ky treats 0 specially), defeating the bound this clamp exists to enforce. (agy convergent)
	const cfgTimeout = clampNumber(
		ConfigManager.get("retrieve.timeout"),
		MIN_TIMEOUT_MS,
		MAX_TIMEOUT_MS,
		50000,
	);
	const cfgRetryLimit = clampNumber(
		ConfigManager.get("retrieve.retry.limit"),
		0,
		MAX_RETRY_LIMIT,
		5,
	);
	const cfgBackoffLimit = clampNumber(
		ConfigManager.get("retrieve.retry.backoffLimit"),
		0,
		MAX_BACKOFF_LIMIT_MS,
		3000,
	);
	const cid = nextCid();
	const startedAt = performance.now();
	requestUnlimitedLogger.trace("endPoint: request", {
		cid,
		url: safeUrl(url),
		timeout: cfgTimeout,
		retryLimit: cfgRetryLimit,
		backoffLimit: cfgBackoffLimit,
	});
	const defaultRetry = DEFAULT_REQUEST_OPTIONS.retry as Record<string, unknown>;

	// 4. Construct final options. Config overrides win over defaults; caller options win over config.
	// Manually concat hooks to ensure default 'beforeRetry' is preserved.
	const kyOptions = customDeepmerge(
		DEFAULT_REQUEST_OPTIONS,
		{
			timeout: cfgTimeout,
			retry: {
				...defaultRetry,
				limit: cfgRetryLimit,
				backoffLimit: cfgBackoffLimit,
				delay: (attempt: number) => fullJitterDelay(attempt, cfgBackoffLimit),
			},
		},
		remainingOptions,
		{
			headers: { ...normalizedDefaultHeaders, ...normalizedInputHeaders },
			hooks: {
				beforeRetry: [
					...(DEFAULT_REQUEST_OPTIONS.hooks?.beforeRetry || []),
					// Per-call so the retry trace correlates to this request's cid.
					async ({ retryCount }) => {
						requestUnlimitedLogger.trace("endPoint: retry", {
							cid,
							retryCount,
							durationMs: performance.now() - startedAt,
						});
					},
					...(hooks?.beforeRetry || []),
				],
			},
		},
	) as KyOptions;

	try {
		const responseObject = await ky(url, kyOptions);
		const response = await serializeResponse<T>(responseObject);

		requestUnlimitedLogger.trace("endPoint: ok", {
			cid,
			durationMs: performance.now() - startedAt,
			url: safeUrl(url),
			status: responseObject.status,
		});
		return {
			status: "success",
			value: response as SerializedResponse<T>,
		};
	} catch (error: unknown) {
		// @ts-expect-error - ky error property
		if (error instanceof HTTPError || error.response) {
			const errorResponse = await serializeResponse<T>(
				// @ts-expect-error - ky error property
				error.response,
			);

			requestUnlimitedLogger.trace("endPoint: error", {
				cid,
				durationMs: performance.now() - startedAt,
				status: errorResponse?.status,
				errorMsg: "HTTP error",
			});
			requestUnlimitedLogger.warn("HTTP Error", {
				cid,
				status: errorResponse?.status,
				url: url.toString(),
			});

			return {
				status: "error",
				reason: errorResponse as SerializedResponse<T>,
			};
		}

		const serializedError = serializeError(error);
		requestUnlimitedLogger.trace("endPoint: error", {
			cid,
			durationMs: performance.now() - startedAt,
			errorMsg: serializedError?.message ?? "internal/network error",
		});
		requestUnlimitedLogger.error("Internal/Network Error", {
			cid,
			error: serializedError,
		});

		return {
			status: "error",
			reason: serializedError,
		};
	}
}

/**
 * Makes parallel HTTP requests to multiple URLs.
 * @param urls - Array of URLs or Request objects to fetch.
 * @param options - Optional ky configuration to apply to all requests.
 * @returns A Promise resolving to an array of RequestResults (in input order).
 * @template T - The expected response body type for each request.
 */
export async function endPoints<T = unknown>(
	urls: (string | URL | Request)[],
	options: KyOptions = {},
): Promise<RequestResult<T>[]> {
	const cid = nextCid();
	const startedAt = performance.now();
	requestUnlimitedLogger.trace("endPoints: batch", { cid, count: urls.length });
	const promises = urls.map((url) => endPoint<T>(url, options));
	const results = await Promise.allSettled(promises);

	const mapped = results.map((result) => {
		if (result.status === "fulfilled") return result.value;
		return {
			status: "error",
			reason: serializeError(result.reason),
		} as RequestResult<T>;
	});

	const ok = mapped.filter((r) => r.status === "success").length;
	requestUnlimitedLogger.trace("endPoints: done", {
		cid,
		durationMs: performance.now() - startedAt,
		ok,
		failed: mapped.length - ok,
	});
	return mapped;
}

/**
 * @deprecated Use endPoint/endPoints functions directly.
 */
export const RequestUnlimited = {
	defaults: DEFAULT_REQUEST_OPTIONS,
	endPoint,
	endPoints,
};
