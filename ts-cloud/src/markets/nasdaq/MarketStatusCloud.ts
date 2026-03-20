/**
 * @file ts-cloud/src/markets/nasdaq/MarketStatusCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib-markets' MarketStatus logic.
 * Purpose: Expose resilient Nasdaq market status fetching on edge environments.
 */

import { MarketStatus, type NasdaqResult } from "@ckir/corelib-markets";
import { Hono } from "hono";
import { serializeError } from "serialize-error";
import type { AppEnv } from "../../core/types";

/**
 * Hono router for Market Status proxying.
 * Mounted at /api/v1/markets/nasdaq/status in the main application.
 */
export const marketStatusRouter = new Hono<AppEnv>();

/**
 * GET /
 * Proxy for the Nasdaq Market Status API.
 * Uses the resilient getStatus logic from corelib-markets.
 *
 * @returns {Promise<Response>} JSON response containing a NasdaqResult with MarketInfo or an error.
 */
marketStatusRouter.get("/", async (c) => {
	try {
		const result = await MarketStatus.getStatus();
		return c.json(result, 200);
	} catch (error) {
		// Log the error using serialize-error for structured reporting
		c.get("logger")?.error("MarketStatusCloud: Internal execution error", {
			error: serializeError(error),
		});

		// Return a generic fatal error result to the client
		const fatalResult: NasdaqResult = {
			status: "error",
			reason: { message: "Internal Edge Proxy Error" },
		};
		return c.json(fatalResult, 200);
	}
});
