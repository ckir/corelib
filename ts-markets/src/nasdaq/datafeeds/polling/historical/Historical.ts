// ts-markets/src/nasdaq/datafeeds/polling/historical/Historical.ts

import type { SerializedResponse } from "@ckir/corelib";
import { endPoint } from "@ckir/corelib";
import yahooFinance from "@gadicc/yahoo-finance2";
import type { Options as KyOptions } from "ky";
import type { HistoricalOptions } from "./common/types";
import { YahooHistoricalProvider } from "./providers/YahooHistoricalProvider";

// Polyfill Deno for the JSR version of yahoo-finance2 when running in Node.js
if (typeof (globalThis as any).Deno === "undefined") {
	(globalThis as any).Deno = {
		stdout: {
			isTerminal: () => false,
		},
	};
}

/**
 * Custom fetch interceptor that wraps corelib's resilient endPoint (ky).
 * Transforms RequestInit to KyOptions and rebuilds a standard Fetch Response.
 */
async function corelibFetchAdapter(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;

	// 1. Map standard fetch RequestInit to corelib's KyOptions
	const kyOptions: KyOptions = {
		method: init?.method ?? "GET",
		headers: (init?.headers as Record<string, string>) ?? {},
		body: init?.body,
	};

	// 2. Execute the resilient corelib request
	const result = await endPoint<unknown>(url, kyOptions);

	// 3. Handle hard network/internal errors (where corelib returns an ErrorObject instead of a SerializedResponse)
	if (result.status === "error" && !("status" in result.reason)) {
		throw new Error(
			result.reason.message || "Network Error in corelibFetchAdapter",
		);
	}

	// 4. Extract the SerializedResponse (handles both 2xx success and HTTP 4xx/5xx errors safely)
	const serialized =
		result.status === "success"
			? result.value
			: (result.reason as SerializedResponse<unknown>);

	// 5. Reconstruct a Fetch API-compatible Response object for yahoo-finance2
	return {
		ok: serialized.ok,
		status: serialized.status,
		statusText: serialized.statusText,
		url: serialized.url,
		headers: new Headers(serialized.headers as Record<string, string>),
		text: async () =>
			typeof serialized.body === "string"
				? serialized.body
				: JSON.stringify(serialized.body),
		json: async () =>
			typeof serialized.body === "string"
				? JSON.parse(serialized.body)
				: serialized.body,
		blob: async () => new Blob([JSON.stringify(serialized.body)]),
		arrayBuffer: async () =>
			new TextEncoder().encode(JSON.stringify(serialized.body)).buffer,
		clone: function () {
			return this;
		},
		body: null,
		bodyUsed: false,
		redirected: serialized.redirected,
		type: (serialized.type as ResponseType) || "basic",
	} as unknown as Response;
}

// Instantiate yahooFinance with the custom fetch interceptor (v3 API)
const yf = new (yahooFinance as any)({
	fetch: corelibFetchAdapter,
	suppressNotices: ["ripHistorical"],
	versionCheck: false,
});

const defaultProvider = new YahooHistoricalProvider(yf);

/**
 * Historical Data Module
 * Provides standardized access to historical pricing data.
 */
export const Historical = {
	/**
	 * Retrieves historical data for a given symbol.
	 */
	getData: (symbol: string, options: HistoricalOptions) =>
		defaultProvider.getHistoricalData(symbol, options),
};
