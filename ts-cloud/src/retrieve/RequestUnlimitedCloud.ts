/**
 * @file ts-cloud/src/retrieve/RequestUnlimitedCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib's RequestUnlimited logic.
 * Purpose: Expose corelib functionality on edge environments via /api/v1/ky.
 * Note: This proxy is transparent for single requests but returns RequestResult for bulk/error scenarios.
 */

import { endPoint, type RequestResult } from "@ckir/corelib";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../core/types";

export const kyRouter = new Hono<AppEnv>();

/**
 * Maps an arbitrary status code to a Hono-compatible ContentfulStatusCode.
 */
function toContentfulStatus(code: number): ContentfulStatusCode {
	const isNonContentful =
		(code >= 100 && code < 200) || [204, 205, 304].includes(code);

	if (isNonContentful || code < 100 || code > 599) {
		return 200;
	}

	return code as ContentfulStatusCode;
}

/**
 * POST /
 * Receives a request containing parameters for RequestUnlimited.
 * Supports both single 'url' and bulk 'endPoints' arrays.
 */
kyRouter.post("/", async (c: Context<AppEnv>): Promise<Response> => {
	try {
		const body = await c.req.json().catch(() => null);

		if (!body) {
			return c.json(
				{ status: "error", reason: { message: "Missing request body" } },
				400,
			);
		}

		// Scenario 1: Multiple Endpoints (Bulk)
		if (Array.isArray(body.endPoints)) {
			const results: RequestResult[] = await Promise.all(
				body.endPoints.map(async (ep: { url: string; options?: any }) => {
					if (ep.url) {
						return await endPoint(ep.url, ep.options || {});
					}
					return {
						status: "error",
						reason: { message: "Missing URL in bulk request" },
					};
				}),
			);
			return c.json(results, 200);
		}

		// Scenario 2: Single Endpoint
		if (typeof body.url === "string") {
			const result = await endPoint(body.url, body.options || {});
			if (result.status === "success") {
				const finalStatus = toContentfulStatus(result.value.status);
				return c.json(result.value.body, finalStatus);
			}
			return c.json(result, (result.reason as any)?.status || 500);
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
		c.get("logger")?.error("RequestUnlimitedCloud: Internal execution error", {
			error,
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

/**
 * GET /
 * Support for proxied requests via query parameter (e.g. ?url=...).
 * Used by RequestProxied.
 */
kyRouter.get("/", async (c: Context<AppEnv>): Promise<Response> => {
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

		const result = await endPoint(url, {});

		if (result.status === "success") {
			const finalStatus = toContentfulStatus(result.value.status);
			return c.json(result.value.body, finalStatus);
		}
		return c.json(result, (result.reason as any)?.status || 500);
	} catch (error) {
		c.get("logger")?.error(
			"RequestUnlimitedCloud: Internal execution error (GET)",
			{
				error,
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
