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
	type RequestResult,
} from "@ckir/corelib";
import type { Options } from "ky";
import { DateTime } from "luxon";
import { serializeError } from "serialize-error";

export type CnnResult<T = unknown> =
	| { status: "success"; value: T; details?: unknown }
	| { status: "error"; reason: { message: string; [key: string]: unknown } };

export enum CnnFearAndGreedFilter {
	FearAndGreed = "fear_and_greed",
	FearAndGreedHistorical = "fear_and_greed_historical",
	MarketMomentumSp500 = "market_momentum_sp500",
	MarketMomentumSp125 = "market_momentum_sp125",
	StockPriceStrength = "stock_price_strength",
	StockPriceBreadth = "stock_price_breadth",
	PutCallOptions = "put_call_options",
	MarketVolatilityVix = "market_volatility_vix",
	MarketVolatilityVix50 = "market_volatility_vix_50",
	JunkBondDemand = "junk_bond_demand",
	SafeHavenDemand = "safe_haven_demand",
}

export type CnnFilterInput =
	| CnnFearAndGreedFilter
	| CnnFearAndGreedFilter[]
	| "full";

const ALL_KEYS = Object.values(
	CnnFearAndGreedFilter,
) as CnnFearAndGreedFilter[];
const CHROME_VERSION = "146";

function getDefaultHeaders(): Record<string, string> {
	return {
		accept: "*/*",
		"accept-language": "en,el;q=0.9",
		origin: "https://edition.cnn.com",
		priority: "u=1, i",
		referer: "https://edition.cnn.com/",
		"sec-ch-ua": `"Chromium";v="${CHROME_VERSION}", "Not-A.Brand";v="24", "Google Chrome";v="${CHROME_VERSION}"`,
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": '"Windows"',
		"sec-fetch-dest": "empty",
		"sec-fetch-mode": "cors",
		"sec-fetch-site": "cross-site",
		"user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`,
	};
}

function getHeaders(): Record<string, string> {
	const configHeaders = ConfigManager.get("markets.cnn.headers") as
		| Record<string, string>
		| undefined;
	return { ...getDefaultHeaders(), ...(configHeaders ?? {}) };
}

/**
 * Logs using the full StrictLogger levels (debug, info, warn, error, fatal, trace).
 * Console fallback is safe (maps fatal/trace to existing console methods).
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

	if (logger) {
		logger[level](`[CNN] ${msg}`, payload);
	} else {
		// Safe console fallback – Console type has no "fatal" or "trace"
		const method = (console as any)[level] ?? console.error;
		method(`[CNN] ${msg}`, payload ?? "");
	}
}

function buildUrl(date?: string | "Historical"): string {
	const url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
	if (date === "Historical") return url;

	// Explicit yyyy-mm-dd format (DateTime.toISODate() always returns this)
	const finalDate = date ?? DateTime.now().toISODate();
	return `${url}/${finalDate}`;
}

function getFilteredValue(
	body: Record<string, any>,
	filter: CnnFilterInput,
): any {
	if (filter === "full") return body;
	const keys = Array.isArray(filter) ? filter : [filter];
	if (keys.length === 1 && !Array.isArray(filter)) {
		return body[keys[0]];
	}
	const result: Record<string, any> = {};
	keys.forEach((k) => {
		if (k in body) result[k] = body[k];
	});
	return result;
}

function validateKeys(
	body: Record<string, any>,
	filter: CnnFilterInput,
): string | null {
	const keysToCheck =
		filter === "full"
			? ALL_KEYS
			: Array.isArray(filter)
				? filter
				: [filter as CnnFearAndGreedFilter];
	for (const key of keysToCheck) {
		if (!(key in body) || body[key] == null) {
			return `Missing or null key: ${key}`;
		}
	}
	return null;
}

async function getFearAndGreed(
	date?: string | "Historical",
	filter: CnnFilterInput = CnnFearAndGreedFilter.FearAndGreed,
	options: Options = {},
): Promise<CnnResult<any>> {
	const url = buildUrl(date);
	const headers = { ...getHeaders(), ...(options.headers ?? {}) };
	const result: RequestResult = await endPoint(url, { ...options, headers });

	if (result.status === "error") {
		log("error", `Transport Error for ${url}`, result.reason);
		return {
			status: "error",
			reason: { message: "Transport Error", original: result.reason },
		};
	}

	const val = result.value;
	const body = val.body as Record<string, any> | null;

	if (!body || typeof body !== "object") {
		const msg = "Malformed CNN Response";
		log("error", msg);
		return { status: "error", reason: { message: msg } };
	}

	const validationError = validateKeys(body, filter);
	if (validationError) {
		log("warn", `Schema validation failed: ${validationError}`, { body });
		return {
			status: "error",
			reason: {
				message: `STRICT SCHEMA VALIDATION FAILED: ${validationError}`,
			},
		};
	}

	const value = getFilteredValue(body, filter);
	log("debug", `CNN FearAndGreed fetched successfully [filter=${filter}]`, {
		url,
	});

	return {
		status: "success",
		value,
		details: { ...val, body: undefined },
	};
}

export const CnnFearAndGreed = { getFearAndGreed };
