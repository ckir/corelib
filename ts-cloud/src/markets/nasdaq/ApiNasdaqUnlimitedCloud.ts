/**
 * @file ts-cloud/src/markets/nasdaq/ApiNasdaqUnlimitedCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib-markets' ApiNasdaqUnlimited logic.
 * Purpose: Expose resilient Nasdaq API fetching on edge environments via /api/v1/markets/nasdaq.
 */

import { ApiNasdaqUnlimited, type NasdaqResult } from "@ckir/corelib-markets";
import { Hono } from "hono";
import type { Options as KyOptions } from "ky";
import type { AppEnv } from "../../core/router";

export const nasdaqRouter = new Hono<AppEnv>();

/**
 * POST /
 * Receives a request containing parameters for ApiNasdaqUnlimited.
 * Supports both single 'url' and bulk 'endPoints' arrays.
 * Clients can pass custom 'options' (KyOptions), but Nasdaq-specific headers
 * will always be enforced and merged by the underlying ApiNasdaqUnlimited wrapper.
 * * HTTP Status is always 200 OK. Errors are encapsulated in the NasdaqResult JSON body.
 */
nasdaqRouter.post("/", async (c) => {
	try {
		const body = await c.req.json().catch(() => null);

		if (!body || typeof body !== "object") {
			const errorResult: NasdaqResult = {
				status: "error",
				reason: { message: "Missing or invalid request body" },
			};
			return c.json(errorResult, 200);
		}

		// Scenario 1: Multiple Endpoints (Bulk)
		if (Array.isArray(body.endPoints)) {
			const results: NasdaqResult[] = [];
			for (const ep of body.endPoints) {
				if (
					typeof ep === "object" &&
					ep !== null &&
					typeof ep.url === "string"
				) {
					// Process sequentially to respect individual options, matching RequestUnlimitedCloud behavior
					results.push(
						await ApiNasdaqUnlimited.endPoint(
							ep.url,
							(ep.options as KyOptions) || {},
						),
					);
				}
			}
			return c.json(results, 200);
		}

		// Scenario 2: Single Endpoint
		if (typeof body.url === "string") {
			const result = await ApiNasdaqUnlimited.endPoint(
				body.url,
				(body.options as KyOptions) || {},
			);
			return c.json(result, 200);
		}

		const invalidPayloadResult: NasdaqResult = {
			status: "error",
			reason: {
				message:
					"Invalid payload. Expected 'url' (string) or 'endPoints' (array).",
			},
		};
		return c.json(invalidPayloadResult, 200);
	} catch (error) {
		c.get("logger")?.error(
			"ApiNasdaqUnlimitedCloud: Internal execution error",
			{
				error,
			},
		);

		const fatalResult: NasdaqResult = {
			status: "error",
			reason: { message: "Internal Edge Proxy Error" },
		};
		return c.json(fatalResult, 200);
	}
});
