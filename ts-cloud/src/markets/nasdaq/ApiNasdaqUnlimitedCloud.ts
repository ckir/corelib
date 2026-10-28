/**
 * @file ts-cloud/src/markets/nasdaq/ApiNasdaqUnlimitedCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib-markets' ApiNasdaqUnlimited logic.
 * Purpose: Expose resilient Nasdaq API fetching on edge environments via /api/v1/markets/nasdaq.
 * Note: This proxy is transparent (returns Nasdaq response directly) but automatically injects Nasdaq spoof headers.
 */

import { endPoint } from "@ckirg/corelib";
import { getNasdaqHeaders, getSymbolsTop100 } from "@ckirg/corelib-markets";
import { type Context, Hono } from "hono";
import type { Options as KyOptions } from "ky";
import { serializeError } from "serialize-error";
import { errorStatus, toContentfulStatus } from "../../core/http-status";
import { rejectOversizedBulk } from "../../core/limits";
import type { AppEnv } from "../../core/types";
import { checkProxyTarget } from "../../core/url-guard";

/**
 * Hono router for Nasdaq API proxying.
 * Mounted at /api/v1/markets/nasdaq in the main application.
 */
export const nasdaqRouter = new Hono<AppEnv>();

/** This proxy exists for Nasdaq's unofficial API; it must not relay requests to other hosts. */
const NASDAQ_ONLY = { allowedHostSuffixes: ["nasdaq.com"] };

/**
 * Middleware to inject a child logger for Nasdaq operations.
 */
nasdaqRouter.use("*", async (c, next) => {
	const parentLogger = c.get("logger");
	if (parentLogger?.child) {
		const nasdaqLogger = parentLogger.child({
			section: "ApiNasdaqUnlimitedCloud",
		});
		c.set("logger", nasdaqLogger);
	}
	await next();
});

/**
 * GET /groups/top100
 * Retrieves the list of Nasdaq 100 symbols.
 */
nasdaqRouter.get(
	"/groups/top100",
	async (c: Context<AppEnv>): Promise<Response> => {
		try {
			const symbols = await getSymbolsTop100();
			return c.json({ status: "success", value: symbols }, 200);
		} catch (error) {
			c.get("logger")?.error(
				"ApiNasdaqUnlimitedCloud: Failed to fetch Top 100",
				{
					error: serializeError(error),
				},
			);
			return c.json(
				{
					status: "error",
					reason: { message: "Failed to retrieve Nasdaq 100 symbols" },
				},
				500,
			);
		}
	},
);

/**
 * POST /
 * Resilient proxy for Nasdaq API requests.
 * Supports both single URL and bulk endpoint processing.
 */
nasdaqRouter.post("/", async (c: Context<AppEnv>): Promise<Response> => {
	try {
		const body = await c.req.json().catch(() => null);
		if (!body) {
			return c.json(
				{ status: "error", reason: { message: "Missing body" } },
				400,
			);
		}
		const { url, options, endPoints } = body;

		// Path 1: Single URL request
		if (url && typeof url === "string") {
			const blocked = checkProxyTarget(url, NASDAQ_ONLY);
			if (blocked) {
				return c.json({ status: "error", reason: { message: blocked } }, 400);
			}
			const headers = { ...getNasdaqHeaders(url), ...(options?.headers ?? {}) };
			const result = await endPoint(url, { ...options, headers });

			if (result.status === "success") {
				const finalStatus = toContentfulStatus(result.value.status);
				const respHeaders = result.value.headers || {};
				const safeHeaders: Record<string, string> = {};
				for (const key of ["etag", "cache-control", "last-modified"]) {
					if (respHeaders[key]) safeHeaders[key] = respHeaders[key];
				}
				// Transparently return the Nasdaq response
				return c.json(result.value.body, finalStatus, safeHeaders);
			}
			// Return the transport error directly
			return c.json(result, errorStatus(result.reason));
		}

		// Path 2: Bulk endPoints request
		if (Array.isArray(endPoints)) {
			const tooMany = rejectOversizedBulk(c, endPoints);
			if (tooMany) return tooMany;
			const results = await Promise.all(
				endPoints.map(async (ep: { url: string; options?: KyOptions }) => {
					const blocked = checkProxyTarget(ep?.url, NASDAQ_ONLY);
					if (blocked) {
						return {
							status: "error",
							reason: { message: blocked, status: 400 },
						};
					}
					const headers = {
						...getNasdaqHeaders(ep.url),
						...(ep.options?.headers ?? {}),
					};
					const result = await endPoint(ep.url, { ...ep.options, headers });
					// For bulk, we still return the full RequestResult objects in an array
					return result;
				}),
			);
			return c.json(results, 200);
		}

		return c.json(
			{
				status: "error",
				reason: {
					message:
						"Invalid payload. Expected 'url' (string) or 'endPoints' (array).",
				},
			},
			400,
		);
	} catch (error) {
		c.get("logger")?.error(
			"ApiNasdaqUnlimitedCloud: Internal execution error",
			{
				error: serializeError(error),
			},
		);

		return c.json(
			{
				status: "error",
				reason: { message: "Internal Edge Proxy Error" },
			},
			500,
		);
	}
});

/**
 * GET /
 * Support for proxied requests via query parameter (e.g. ?url=...).
 * Used by RequestProxied.
 */
nasdaqRouter.get("/", async (c: Context<AppEnv>): Promise<Response> => {
	try {
		const url = c.req.query("url");

		if (!url) {
			return c.json(
				{
					status: "error",
					reason: { message: "Missing 'url' query parameter" },
				},
				400,
			);
		}

		const blocked = checkProxyTarget(url, NASDAQ_ONLY);
		if (blocked) {
			return c.json({ status: "error", reason: { message: blocked } }, 400);
		}

		const headers = getNasdaqHeaders(url);
		const result = await endPoint(url, { headers });

		if (result.status === "success") {
			return c.json(result.value.body, toContentfulStatus(result.value.status));
		}
		return c.json(result, errorStatus(result.reason));
	} catch (error) {
		c.get("logger")?.error(
			"ApiNasdaqUnlimitedCloud: Internal execution error (GET)",
			{
				error: serializeError(error),
			},
		);

		return c.json(
			{
				status: "error",
				reason: { message: "Internal Edge Proxy Error" },
			},
			500,
		);
	}
});
