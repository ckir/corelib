/**
 * @file ts-cloud/src/markets/nasdaq/HistoricalCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib-markets' Historical logic.
 * Purpose: Expose resilient historical data fetching on edge environments.
 */

import { Historical } from "@ckir/corelib-markets";
import { type Context, Hono } from "hono";
import { serializeError } from "serialize-error";
import type { AppEnv } from "../../core/types";

/**
 * Hono router for Historical Data proxying.
 * Mounted at /api/v1/markets/nasdaq/historical in the main application.
 */
export const historicalRouter = new Hono<AppEnv>();

/**
 * Middleware to inject a child logger for Historical operations.
 */
historicalRouter.use("*", async (c, next) => {
	const parentLogger = c.get("logger");
	if (parentLogger?.child) {
		const historicalLogger = parentLogger.child({ section: "HistoricalCloud" });
		c.set("logger", historicalLogger);
	}
	await next();
});

// Safely infer types from the Historical module since they aren't explicitly exported in the barrel
type HistoricalOptions = Parameters<typeof Historical.getData>[1];
type HistoricalResult = Awaited<ReturnType<typeof Historical.getData>>;

/**
 * Interface defining the expected payload for a single historical data request.
 */
interface HistoricalRequest {
	symbol: string;
	options: HistoricalOptions;
}

/**
 * POST /
 * Resilient proxy for Historical API requests.
 * Supports both single request and bulk endpoint processing.
 */
historicalRouter.post("/", async (c: Context<AppEnv>): Promise<Response> => {
	try {
		const body = await c.req.json().catch(() => null);

		if (!body) {
			return c.json(
				{ status: "error", reason: { message: "Missing request body" } },
				400,
			);
		}

		// Scenario 1: Multiple Requests (Bulk)
		if (Array.isArray(body.requests)) {
			const results: HistoricalResult[] = await Promise.all(
				body.requests.map(async (req: HistoricalRequest) => {
					if (req.symbol && req.options) {
						return await Historical.getData(req.symbol, req.options);
					}
					return {
						status: "error",
						reason: {
							message: "Missing symbol or options in bulk request payload",
						},
					};
				}),
			);
			// Bulk requests return an array of standardized result objects
			return c.json(results, 200);
		}

		// Scenario 2: Single Request
		if (typeof body.symbol === "string" && body.options) {
			const result = await Historical.getData(body.symbol, body.options);

			if (result.status === "success") {
				// Transparently return the cleaned/parsed HistoricalQuote[] array
				return c.json(result.value, 200);
			}

			// Return the full error object if the fetch failed
			return c.json(result, 500);
		}

		return c.json(
			{
				status: "error",
				reason: {
					message:
						"Invalid payload. Expected 'symbol' and 'options' OR 'requests' (array).",
				},
			},
			400,
		);
	} catch (error) {
		c.get("logger")?.error("HistoricalCloud: Internal execution error", {
			error: serializeError(error),
		});

		return c.json(
			{
				status: "error",
				reason: { message: "Internal Edge Proxy Error" },
			},
			500,
		);
	}
});
