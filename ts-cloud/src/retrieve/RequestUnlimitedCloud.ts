/**
 * @file ts-cloud/src/retrieve/RequestUnlimitedCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib's RequestUnlimited logic.
 * Purpose: Expose corelib functionality on edge environments via /api/v1/ky.
 * Note: This proxy is transparent for single requests but returns RequestResult for bulk/error scenarios.
 */

import { endPoint, type RequestResult } from "@ckirg/corelib";
import { type Context, Hono } from "hono";
import type { Options as KyOptions } from "ky";
import { errorStatus, toContentfulStatus } from "../core/http-status";
import { rejectOversizedBulk } from "../core/limits";
import type { AppEnv } from "../core/types";
import { checkProxyTarget } from "../core/url-guard";

/**
 * Hono router for generic HTTP proxying via RequestUnlimited.
 * Mounted at /api/v1/ky in the main application.
 */
export const kyRouter = new Hono<AppEnv>();

/**
 * Middleware to inject a child logger for general HTTP proxying.
 */
kyRouter.use("*", async (c, next) => {
	const parentLogger = c.get("logger");
	if (parentLogger?.child) {
		const kyLogger = parentLogger.child({ section: "RequestUnlimitedCloud" });
		c.set("logger", kyLogger);
	}
	await next();
});

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
			const tooMany = rejectOversizedBulk(c, body.endPoints);
			if (tooMany) return tooMany;
			const results: RequestResult[] = await Promise.all(
				body.endPoints.map(async (ep: { url: string; options?: KyOptions }) => {
					if (!ep.url) {
						return {
							status: "error",
							reason: { message: "Missing URL in bulk request" },
						};
					}
					const blocked = checkProxyTarget(ep.url);
					if (blocked) {
						return {
							status: "error",
							reason: { message: blocked, status: 400 },
						};
					}
					return await endPoint(ep.url, ep.options || {});
				}),
			);
			return c.json(results, 200);
		}

		// Scenario 2: Single Endpoint
		if (typeof body.url === "string") {
			const blocked = checkProxyTarget(body.url);
			if (blocked) {
				return c.json({ status: "error", reason: { message: blocked } }, 400);
			}
			const result = await endPoint(body.url, body.options || {});
			if (result.status === "success") {
				const finalStatus = toContentfulStatus(result.value.status);
				return c.json(result.value.body, finalStatus);
			}
			return c.json(result, errorStatus(result.reason));
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

		const blocked = checkProxyTarget(url);
		if (blocked) {
			return c.json({ status: "error", reason: { message: blocked } }, 400);
		}

		const result = await endPoint(url, {});

		if (result.status === "success") {
			const finalStatus = toContentfulStatus(result.value.status);
			return c.json(result.value.body, finalStatus);
		}
		return c.json(result, errorStatus(result.reason));
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
