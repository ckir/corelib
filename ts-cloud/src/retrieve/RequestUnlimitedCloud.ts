/**
 * @file ts-cloud/src/retrieve/RequestUnlimitedCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib's RequestUnlimited logic.
 * Purpose: Expose corelib functionality on edge environments via /api/v1/ky.
 */

import { endPoint, type RequestResult } from "@ckir/corelib";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../core/types";

export const kyRouter = new Hono<AppEnv>();

/**
 * Maps an arbitrary status code to a Hono-compatible ContentfulStatusCode.
 * If the status code prohibits a response body (e.g., 204, 304, 1xx),
 * it defaults to 200 to allow the JSON metadata to be sent.
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
 * Extracts the underlying HTTP status code from a corelib RequestResult.
 */
function getInnerStatus(result: RequestResult): number {
	if (result.status === "success") {
		return result.value.status;
	}
	if (
		result.status === "error" &&
		result.reason &&
		typeof result.reason === "object" &&
		"status" in result.reason &&
		typeof (result.reason as { status?: number }).status === "number"
	) {
		return (result.reason as { status: number }).status;
	}
	return 500;
}

/**
 * POST /
 * Receives a request containing parameters for RequestUnlimited.
 * Supports both single 'url' and bulk 'endPoints' arrays.
 */
kyRouter.post("/", async (c) => {
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
			const results: RequestResult[] = [];
			for (const ep of body.endPoints) {
				if (ep.url) {
					results.push(await endPoint(ep.url, ep.options || {}));
				}
			}
			// Outer status is 200 to allow the array of results in the body
			return c.json(results, 200);
		}

		// Scenario 2: Single Endpoint
		if (typeof body.url === "string") {
			const result = await endPoint(body.url, body.options || {});
			const innerStatus = getInnerStatus(result);
			const finalStatus = toContentfulStatus(innerStatus);

			return c.json(result, finalStatus);
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
