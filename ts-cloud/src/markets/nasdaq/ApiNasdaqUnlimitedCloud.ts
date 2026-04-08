/**
 * @file ts-cloud/src/markets/nasdaq/ApiNasdaqUnlimitedCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib-markets' ApiNasdaqUnlimited logic.
 * Purpose: Expose resilient Nasdaq API fetching on edge environments via /api/v1/markets/nasdaq.
 * Note: This proxy is transparent (returns Nasdaq response directly) but automatically injects Nasdaq spoof headers.
 */

import { endPoint, type RequestResult } from "@ckir/corelib";
import { getNasdaqHeaders } from "@ckir/corelib-markets";
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
 */
nasdaqRouter.post("/", async (c) => {
	try {
		const body = await c.req.json().catch(() => null);
		if (!body) {
			return c.json({ status: "error", reason: { message: "Missing body" } }, 400);
		}
		const { url, options, endPoints } = body;

		// Path 1: Single URL request
		if (url && typeof url === "string") {
			const headers = { ...getNasdaqHeaders(url), ...(options?.headers ?? {}) };
			const result = await endPoint(url, { ...options, headers });

			if (result.status === "success") {
				// Transparently return the Nasdaq response
				return c.json(result.value.body, result.value.status as any);
			}
			// Return the transport error directly
			return c.json(result, (result.reason as any)?.status || 500);
		}

		// Path 2: Bulk endPoints request
		if (Array.isArray(endPoints)) {
			const results = await Promise.all(
				endPoints.map(async (ep: { url: string; options?: KyOptions }) => {
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
nasdaqRouter.get("/", async (c) => {
	try {
		const url = c.req.query("url");

		if (!url) {
			return c.json(
				{ status: "error", reason: { message: "Missing 'url' query parameter" } },
				400,
			);
		}

		const headers = getNasdaqHeaders(url);
		const result = await endPoint(url, { headers });

		if (result.status === "success") {
			return c.json(result.value.body, result.value.status as any);
		}
		return c.json(result, (result.reason as any)?.status || 500);
	} catch (error) {
		c.get("logger")?.error("ApiNasdaqUnlimitedCloud: Internal execution error (GET)", {
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
