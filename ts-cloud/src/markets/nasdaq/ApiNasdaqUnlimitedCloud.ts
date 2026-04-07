/**
 * @file ts-cloud/src/markets/nasdaq/ApiNasdaqUnlimitedCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib-markets' ApiNasdaqUnlimited logic.
 * Purpose: Expose resilient Nasdaq API fetching on edge environments via /api/v1/markets/nasdaq.
 */

import { ApiNasdaqUnlimited, type NasdaqResult } from "@ckir/corelib-markets";
import { Hono } from "hono";
import type { Options as KyOptions } from "ky";
import { serializeError } from "serialize-error";
import type { AppEnv } from "../../core/types";

/**
 * Hono router for Nasdaq API proxying.
 * Mounted at /api/v1/markets/nasdaq in the main application.
 */
export const nasdaqRouter = new Hono<AppEnv>();

/**
 * POST /
 * Resilient proxy for Nasdaq API requests.
 * Supports both single URL and bulk endpoint processing.
 *
 * @param {Request} c - Hono context object containing request body and environment variables.
 * @returns {Promise<Response>} JSON response containing a single NasdaqResult or an array for bulk requests.
 */
nasdaqRouter.post("/", async (c) => {
	try {
		const body = await c.req.json();
		const { url, options, endPoints } = body;

		// Path 1: Single URL request
		if (url && typeof url === "string") {
			const result = await ApiNasdaqUnlimited.endPoint(url, options || {});
			return c.json(result, 200);
		}

		// Path 2: Bulk endPoints request
		if (Array.isArray(endPoints)) {
			const results = await Promise.all(
				endPoints.map(async (ep: { url: string; options?: KyOptions }) => {
					return ApiNasdaqUnlimited.endPoint(ep.url, ep.options || {});
				}),
			);
			return c.json(results, 200);
		}

		// Path 3: Invalid Payload
		const invalidPayloadResult: NasdaqResult = {
			status: "error",
			reason: {
				message:
					"Invalid payload. Expected 'url' (string) or 'endPoints' (array).",
			},
		};
		return c.json(invalidPayloadResult, 200);
	} catch (error) {
		// Log the error using serialize-error for structured reporting
		c.get("logger")?.error(
			"ApiNasdaqUnlimitedCloud: Internal execution error",
			{
				error: serializeError(error),
			},
		);

		// Return a generic fatal error result to the client
		const fatalResult: NasdaqResult = {
			status: "error",
			reason: { message: "Internal Edge Proxy Error" },
		};
		return c.json(fatalResult, 200);
	}
});
