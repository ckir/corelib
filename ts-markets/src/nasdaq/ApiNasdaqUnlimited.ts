// =============================================
// FILE: ts-markets/src/nasdaq/ApiNasdaqUnlimited.ts
// PURPOSE: Nasdaq API wrapper using RequestUnlimited with custom headers and response verification.
// Integrates with ConfigManager for optional header overrides.
// =============================================

import { ConfigManager, endPoint, type RequestResult } from "@ckir/corelib";
import type { Options } from "ky";
import { serializeError } from "serialize-error";

export interface NasdaqStatus {
	rCode: number;
	bCodeMessage: Array<{ code: string; errorMessage: string }> | null;
	developerMessage: string | null;
}

export type NasdaqResult<T = unknown> =
	| { status: "success"; value: T; details?: unknown }
	| { status: "error"; reason: { message: string; [key: string]: unknown } };

const CHROME_VERSION = "145";

function apiErrorToString(status: NasdaqStatus): string {
	if (!status.bCodeMessage || status.bCodeMessage.length === 0) {
		return status.developerMessage || "Unknown Nasdaq API Error";
	}
	return status.bCodeMessage
		.map((err) => `code: ${err.code} = ${err.errorMessage}`)
		.join("::");
}

function log(
	level: "info" | "warn" | "error",
	msg: string,
	data?: unknown,
): void {
	const logger = globalThis.logger;
	const payload =
		data instanceof Error
			? { error: serializeError(data) }
			: (data as Record<string, unknown> | undefined);

	if (logger) {
		logger[level](`[Nasdaq] ${msg}`, payload);
	} else {
		console[level](`[Nasdaq] ${msg}`, payload ?? "");
	}
}

function getHeaders(url: string): Record<string, string> {
	const isCharting = url.includes("charting");
	const headers: Record<string, string> = isCharting
		? {
				accept: "*/*",
				"accept-language": "en-US,en;q=0.9",
				"cache-control": "no-cache",
				pragma: "no-cache",
				priority: "u=1, i",
				"sec-ch-ua": `"Google Chrome";v="${CHROME_VERSION}", "Not-A.Brand";v="8", "Chromium";v="${CHROME_VERSION}"`,
				"sec-ch-ua-mobile": "?0",
				"sec-ch-ua-platform": '"Windows"',
				"sec-fetch-dest": "empty",
				"sec-fetch-mode": "cors",
				"sec-fetch-site": "same-origin",
				referer: "https://charting.nasdaq.com/dynamic/chart.html",
				"user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`,
			}
		: {
				accept: "application/json, text/plain, */*",
				"accept-language": "en-US,en;q=0.9",
				origin: "https://www.nasdaq.com",
				referer: "https://www.nasdaq.com/",
				"sec-ch-ua": `"Google Chrome";v="${CHROME_VERSION}", "Not-A.Brand";v="8", "Chromium";v="${CHROME_VERSION}"`,
				"sec-ch-ua-mobile": "?0",
				"sec-ch-ua-platform": '"Windows"',
				"user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`,
			};

	const configHeaders = ConfigManager.get("markets.nasdaq.headers") as
		| Record<string, string>
		| undefined;
	return configHeaders ? { ...headers, ...configHeaders } : headers;
}

async function nasdaqEndPoint<T = unknown>(
	url: string | URL | Request,
	options: Options = {},
): Promise<NasdaqResult<T>> {
	const urlStr = typeof url === "string" ? url : url.toString();
	const headers = { ...getHeaders(urlStr), ...(options.headers ?? {}) };
	const result: RequestResult = await endPoint(url, { ...options, headers });

	if (result.status === "error") {
		log("error", `Transport Error for ${urlStr}`, result.reason);
		return {
			status: "error",
			reason: { message: "Transport Error", original: result.reason },
		};
	}

	const val = result.value;
	const nasdaqBody = val.body as Record<string, any> | null;

	if (
		nasdaqBody &&
		typeof nasdaqBody === "object" &&
		"status" in nasdaqBody &&
		nasdaqBody.status?.rCode !== 200
	) {
		log("warn", `Request to ${urlStr} failed logic check`, {
			status: nasdaqBody.status,
		});

		const errorMessage = nasdaqBody.status
			? apiErrorToString(nasdaqBody.status as NasdaqStatus)
			: "Malformed Nasdaq Response";

		return {
			status: "error",
			reason: { message: errorMessage },
		};
	}

	const { body, ...details } = val;

	return {
		status: "success",
		value: (body as any)?.data as T,
		details,
	};
}

async function nasdaqEndPoints<T = unknown>(
	urls: (string | URL | Request)[],
	options: Options = {},
): Promise<NasdaqResult<T>[]> {
	const promises = urls.map((url) => nasdaqEndPoint<T>(url, options));
	return Promise.all(promises);
}

export const ApiNasdaqUnlimited = {
	endPoint: nasdaqEndPoint,
	endPoints: nasdaqEndPoints,
};
