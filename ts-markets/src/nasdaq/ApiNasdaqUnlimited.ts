// =============================================
// FILE: ts-markets/src/nasdaq/ApiNasdaqUnlimited.ts
// PURPOSE: Nasdaq API wrapper using RequestUnlimited with custom headers and response verification.
// Integrates with ConfigManager for optional header overrides.
// =============================================

import {
	ConfigManager,
	endPoint,
	logger,
	type RequestResult,
} from "@ckir/corelib";

const nasdaqUnlimitedLogger = logger.child({ section: "ApiNasdaqUnlimited" });

import type { Options } from "ky";
import { serializeError } from "serialize-error";

/**
 * Standard Nasdaq API status object returned in the response body.
 */
export interface NasdaqStatus {
	/** HTTP-like response code from the API logic layer. */
	rCode: number;
	/** Array of business-level error codes and messages. */
	bCodeMessage: Array<{ code: string; errorMessage: string }> | null;
	/** Developer-friendly message for debugging. */
	developerMessage: string | null;
}

/**
 * Result pattern for Nasdaq API calls.
 * @template T The type of the value on success.
 */
export type NasdaqResult<T = unknown> =
	| {
			/** Indicates a successful request and logic check. */
			status: "success";
			/** The data returned by the API (usually the contents of the 'data' field). */
			value: T;
			/** Optional details about the response (headers, status, etc.). */
			details?: unknown;
	  }
	| {
			/** Indicates a transport error or an API-level logic error. */
			status: "error";
			/** The reason for the failure. */
			reason: { message: string; [key: string]: unknown };
	  };

/**
 * Converts a NasdaqStatus object into a human-readable error string.
 *
 * @param {NasdaqStatus} status - The status object from the API response.
 * @returns {string} A formatted error message.
 */
function apiErrorToString(status: NasdaqStatus): string {
	if (!status.bCodeMessage || status.bCodeMessage.length === 0) {
		return status.developerMessage || "Unknown Nasdaq API Error";
	}
	return status.bCodeMessage
		.map((err) => `code: ${err.code} = ${err.errorMessage}`)
		.join("::");
}

/**
 * Internal logger helper for consistent formatting.
 *
 * @param {"info" | "warn" | "error"} level - The log level.
 * @param {string} msg - The log message.
 * @param {unknown} [data] - Optional metadata or error object.
 */
function log(
	level: "info" | "warn" | "error",
	msg: string,
	data?: unknown,
): void {
	const payload =
		data instanceof Error
			? { error: serializeError(data) }
			: (data as Record<string, unknown> | undefined);

	nasdaqUnlimitedLogger[level](msg, payload);
}

/**
 * Generates spoofed headers for Nasdaq API requests to ensure compatibility.
 * Dynamically handles differences between standard API calls and charting-specific endpoints.
 *
 * @param {string} url - The URL of the request.
 * @returns {Record<string, string>} A dictionary of headers.
 */
export function getNasdaqHeaders(url: string): Record<string, string> {
	const chromeVersion =
		(ConfigManager.get("markets.chromeVersion") as string | undefined) ?? "145";
	const isCharting = url.includes("charting");
	const headers: Record<string, string> = isCharting
		? {
				accept: "*/*",
				"accept-language": "en-US,en;q=0.9",
				"cache-control": "no-cache",
				pragma: "no-cache",
				priority: "u=1, i",
				"sec-ch-ua": `"Google Chrome";v="${chromeVersion}", "Not-A.Brand";v="8", "Chromium";v="${chromeVersion}"`,
				"sec-ch-ua-mobile": "?0",
				"sec-ch-ua-platform": '"Windows"',
				"sec-fetch-dest": "empty",
				"sec-fetch-mode": "cors",
				"sec-fetch-site": "same-origin",
				referer: "https://charting.nasdaq.com/dynamic/chart.html",
				"user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
			}
		: {
				accept: "application/json, text/plain, */*",
				"accept-language": "en-US,en;q=0.9",
				origin: "https://www.nasdaq.com",
				referer: "https://www.nasdaq.com/",
				"sec-ch-ua": `"Google Chrome";v="${chromeVersion}", "Not-A.Brand";v="8", "Chromium";v="${chromeVersion}"`,
				"sec-ch-ua-mobile": "?0",
				"sec-ch-ua-platform": '"Windows"',
				"user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
			};

	const configHeaders = ConfigManager.get("markets.nasdaq.headers") as
		| Record<string, string>
		| undefined;
	return configHeaders ? { ...headers, ...configHeaders } : headers;
}

/**
 * Executes a single Nasdaq API request with automatic header spoofing and logic check.
 *
 * @template T The expected type of the data returned in the 'data' field.
 * @param {string | URL | Request} url - The URL or request object.
 * @param {Options} [options] - Additional request options (passed to ky).
 * @returns {Promise<NasdaqResult<T>>} A promise resolving to a NasdaqResult.
 */
async function nasdaqEndPoint<T = unknown>(
	url: string | URL | Request,
	options: Options = {},
): Promise<NasdaqResult<T>> {
	const urlStr = typeof url === "string" ? url : url.toString();
	const headers = { ...getNasdaqHeaders(urlStr), ...(options.headers ?? {}) };
	const result: RequestResult = await endPoint(url, { ...options, headers });

	if (result.status === "error") {
		log("error", "Transport Error", { url: urlStr, reason: result.reason });
		return {
			status: "error",
			reason: { message: "Transport Error", original: result.reason },
		};
	}

	const val = result.value;
	const nasdaqBody = val.body as Record<string, unknown> | null;

	if (nasdaqBody && typeof nasdaqBody === "object" && "status" in nasdaqBody) {
		const statusObj = nasdaqBody.status as Record<string, unknown> | undefined;
		if (statusObj?.rCode !== 200) {
			log("warn", "Request failed logic check", {
				url: urlStr,
				status: nasdaqBody.status,
			});

			const errorMessage = statusObj
				? apiErrorToString(statusObj as unknown as NasdaqStatus)
				: "Malformed Nasdaq Response";

			return {
				status: "error",
				reason: { message: errorMessage },
			};
		}
	}

	const { body, ...details } = val;

	return {
		status: "success",
		value: (body as Record<string, unknown>)?.data as T,
		details,
	};
}

/**
 * Executes multiple Nasdaq API requests in parallel.
 *
 * @template T The expected type of the data returned by each request.
 * @param {(string | URL | Request)[]} urls - Array of URLs or request objects.
 * @param {Options} [options] - Additional request options.
 * @returns {Promise<NasdaqResult<T>[]>} A promise resolving to an array of NasdaqResults.
 */
async function nasdaqEndPoints<T = unknown>(
	urls: (string | URL | Request)[],
	options: Options = {},
): Promise<NasdaqResult<T>[]> {
	const promises = urls.map((url) => nasdaqEndPoint<T>(url, options));
	return Promise.all(promises);
}

/**
 * Nasdaq API integration section.
 */
export const ApiNasdaqUnlimited = {
	/**
	 * Executes a single Nasdaq API request.
	 */
	endPoint: nasdaqEndPoint,
	/**
	 * Executes multiple Nasdaq API requests in parallel.
	 */
	endPoints: nasdaqEndPoints,
};
