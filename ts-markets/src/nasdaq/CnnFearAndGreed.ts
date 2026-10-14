// =============================================
// FILE: ts-markets/src/nasdaq/CnnFearAndGreed.ts
// PURPOSE: CNN Fear & Greed Index wrapper using RequestUnlimited.
// Supports daily data (default = today) or "Historical" (full 1-year).
// Client-side filtering + strict manual schema validation (mirrors MarketStatus).
// Headers exactly match the official curl. Config override via markets.cnn.headers.
// =============================================

import {
	ConfigManager,
	endPoint,
	logger,
	nextCid,
	type RequestResult,
} from "@ckirg/corelib";

const cnnLogger = logger.child({ section: "CnnFearAndGreed" });

import type { Options } from "ky";
import { DateTime } from "luxon";
import { serializeError } from "serialize-error";
import { DEFAULT_CHROME_VERSION } from "./constants";

/**
 * Result pattern for CNN API calls.
 * @template T The type of the value on success.
 */
export type CnnResult<T = unknown> =
	| {
			/** Indicates a successful request and schema validation. */
			status: "success";
			/** The filtered data from the CNN response. */
			value: T;
			/** Optional details about the response. */
			details?: unknown;
	  }
	| {
			/** Indicates a transport error or schema validation failure. */
			status: "error";
			/** The reason for the failure. */
			reason: { message: string; [key: string]: unknown };
	  };

/**
 * Available filters for the CNN Fear & Greed API.
 * Each member corresponds to a key in the raw JSON response.
 */
export enum CnnFearAndGreedFilter {
	/** Overall Fear & Greed Index value and description. */
	FearAndGreed = "fear_and_greed",
	/** Historical Fear & Greed Index values. */
	FearAndGreedHistorical = "fear_and_greed_historical",
	/** Market Momentum based on the S&P 500. */
	MarketMomentumSp500 = "market_momentum_sp500",
	/** Market Momentum based on the S&P 125. */
	MarketMomentumSp125 = "market_momentum_sp125",
	/** Stock Price Strength index. */
	StockPriceStrength = "stock_price_strength",
	/** Stock Price Breadth index. */
	StockPriceBreadth = "stock_price_breadth",
	/** Put and Call Options ratio. */
	PutCallOptions = "put_call_options",
	/** Market Volatility (VIX). */
	MarketVolatilityVix = "market_volatility_vix",
	/** Market Volatility (VIX 50-day moving average). */
	MarketVolatilityVix50 = "market_volatility_vix_50",
	/** Junk Bond Demand index. */
	JunkBondDemand = "junk_bond_demand",
	/** Safe Haven Demand index. */
	SafeHavenDemand = "safe_haven_demand",
}

/**
 * Input type for filtering CNN API results.
 * Can be a single filter, an array of filters, or "full" to return the entire response body.
 */
export type CnnFilterInput =
	| CnnFearAndGreedFilter
	| CnnFearAndGreedFilter[]
	| "full";

const ALL_KEYS = Object.values(
	CnnFearAndGreedFilter,
) as CnnFearAndGreedFilter[];

/**
 * Generates the default headers required for the CNN API.
 * @returns {Record<string, string>} A dictionary of headers.
 */
function getDefaultHeaders(): Record<string, string> {
	const chromeVersion =
		(ConfigManager.get("markets.chromeVersion") as string | undefined) ??
		DEFAULT_CHROME_VERSION;
	return {
		accept: "*/*",
		"accept-language": "en,el;q=0.9",
		origin: "https://edition.cnn.com",
		priority: "u=1, i",
		referer: "https://edition.cnn.com/",
		"sec-ch-ua": `"Chromium";v="${chromeVersion}", "Not-A.Brand";v="24", "Google Chrome";v="${chromeVersion}"`,
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": '"Windows"',
		"sec-fetch-dest": "empty",
		"sec-fetch-mode": "cors",
		"sec-fetch-site": "cross-site",
		"user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
	};
}

/**
 * Gets the headers for the CNN API, including any overrides from ConfigManager.
 * @returns {Record<string, string>} A dictionary of headers.
 */
function getHeaders(): Record<string, string> {
	const configHeaders = ConfigManager.get("markets.cnn.headers") as
		| Record<string, string>
		| undefined;
	return { ...getDefaultHeaders(), ...(configHeaders ?? {}) };
}

/**
 * Internal logger helper.
 */
function log(
	level: "debug" | "info" | "warn" | "error" | "fatal" | "trace",
	msg: string,
	data?: unknown,
): void {
	const payload =
		data instanceof Error
			? { error: serializeError(data) }
			: (data as Record<string, unknown> | undefined);

	cnnLogger[level](msg, payload);
}

/**
 * True when `date` is a YYYY-MM-DD string naming a real calendar date.
 */
function isValidDateString(date: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	const parsed = DateTime.fromISO(date, { zone: "utc" });
	return parsed.isValid && parsed.toISODate() === date;
}

/**
 * Builds the CNN Fear & Greed API URL.
 *
 * @param {string | "Historical"} [date] - Optional date (YYYY-MM-DD) or "Historical".
 * @returns {string} The formatted URL.
 */
function buildUrl(date?: string | "Historical"): string {
	const url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
	if (date === "Historical") return url;

	// Default to the current America/New_York calendar day: the index tracks US market
	// sessions, so the UTC/local day can run ahead of (or behind) the latest published date.
	const finalDate =
		date ?? DateTime.now().setZone("America/New_York").toISODate();
	return `${url}/${finalDate}`;
}

/**
 * Extracts the requested data from the CNN API response body based on the filter.
 *
 * @param {Record<string, unknown>} body - The raw response body.
 * @param {CnnFilterInput} filter - The filter to apply.
 * @returns {unknown} The filtered value.
 */
function getFilteredValue(
	body: Record<string, unknown>,
	filter: CnnFilterInput,
): unknown {
	if (filter === "full") return body;
	const keys = Array.isArray(filter) ? filter : [filter];
	if (keys.length === 1 && !Array.isArray(filter)) {
		return body[keys[0]];
	}
	const result: Record<string, unknown> = {};
	keys.forEach((k) => {
		if (k in body) result[k] = body[k];
	});
	return result;
}

/**
 * Validates that the response body contains the required keys based on the filter.
 *
 * @param {Record<string, unknown>} body - The raw response body.
 * @param {CnnFilterInput} filter - The filter being applied.
 * @returns {string | null} An error message if validation fails, otherwise null.
 */
function validateKeys(
	body: Record<string, unknown>,
	filter: CnnFilterInput,
): string | null {
	if (filter === "full") {
		// "full" returns whichever keys exist; only a body with none of them is invalid.
		return ALL_KEYS.some((k) => body[k] != null)
			? null
			: "Missing or null key: none of the known CNN keys are present";
	}
	const keysToCheck = Array.isArray(filter)
		? filter
		: [filter as CnnFearAndGreedFilter];
	for (const key of keysToCheck) {
		if (!(key in body) || body[key] == null) {
			return `Missing or null key: ${key}`;
		}
	}
	return null;
}

/**
 * Fetches the CNN Fear & Greed Index data.
 *
 * @param {string | "Historical"} [date] - Optional date in YYYY-MM-DD format or "Historical" for 1-year data.
 * @param {CnnFilterInput} [filter=CnnFearAndGreedFilter.FearAndGreed] - Optional filter to apply to the result.
 * @param {Options} [options={}] - Additional request options for ky.
 * @returns {Promise<CnnResult<unknown>>} A promise resolving to a CnnResult.
 */
async function getFearAndGreed(
	date?: string | "Historical",
	filter: CnnFilterInput = CnnFearAndGreedFilter.FearAndGreed,
	options: Options = {},
): Promise<CnnResult<unknown>> {
	const cid = nextCid();
	const startedAt = performance.now();
	if (date !== undefined && date !== "Historical" && !isValidDateString(date)) {
		const msg = `Invalid date: expected YYYY-MM-DD or "Historical"`;
		log("warn", msg, { cid, date });
		return { status: "error", reason: { message: msg } };
	}
	const url = buildUrl(date);
	log("trace", "getFearAndGreed: start", { cid, date, filter });

	const headers = { ...getHeaders(), ...(options.headers ?? {}) };
	const result: RequestResult = await endPoint(url, { ...options, headers });

	if (result.status === "error") {
		log("error", "Transport Error", { url, reason: result.reason });
		return {
			status: "error",
			reason: { message: "Transport Error", original: result.reason },
		};
	}

	const val = result.value;
	const body = val.body as Record<string, unknown> | null;

	if (!body || typeof body !== "object") {
		const msg = "Malformed CNN Response";
		log("error", msg);
		return { status: "error", reason: { message: msg } };
	}

	const validationError = validateKeys(body, filter);
	if (validationError) {
		// Never dump the body: log only the HTTP status and the serialized length.
		let bodyLength: number | null = null;
		try {
			bodyLength = JSON.stringify(body).length;
		} catch {
			bodyLength = null;
		}
		log("warn", "Schema validation failed", {
			validationError,
			status: val.status,
			bodyLength,
		});
		return {
			status: "error",
			reason: {
				message: `STRICT SCHEMA VALIDATION FAILED: ${validationError}`,
			},
		};
	}

	const value = getFilteredValue(body, filter);
	const sampleScore =
		value != null && typeof value === "object" && "score" in value
			? (value as Record<string, unknown>).score
			: undefined;
	log("trace", "getFearAndGreed: done", {
		cid,
		durationMs: performance.now() - startedAt,
		filter,
		sampleScore,
	});

	return {
		status: "success",
		value,
		details: { ...val, body: undefined },
	};
}

/**
 * CNN Fear & Greed Index integration section.
 */
export const CnnFearAndGreed = {
	/**
	 * Fetches Fear & Greed Index data.
	 */
	getFearAndGreed,
};
