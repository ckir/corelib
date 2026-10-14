/**
 * @file ts-cloud/src/core/auth.ts
 * @description Bearer-token authentication for the /api/v1 routes.
 * The token comes from the CORELIB_API_TOKEN binding (or process.env). If none is configured the
 * middleware denies every request (503) instead of allowing them: an unconfigured deployment must not be open.
 */

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./types";

const encoder = new TextEncoder();

/** Compares two strings in constant time by comparing their SHA-256 digests. */
async function safeEqual(a: string, b: string): Promise<boolean> {
	const [dx, dy] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	const x = new Uint8Array(dx);
	const y = new Uint8Array(dy);
	let diff = 0;
	for (let i = 0; i < x.length; i++) {
		const xi = x[i];
		const yi = y[i];
		// Unreachable (both digests are 32 bytes); fail closed if it ever happens.
		if (xi === undefined || yi === undefined) return false;
		diff |= xi ^ yi;
	}
	return diff === 0;
}

export const requireApiToken = createMiddleware<AppEnv>(async (c, next) => {
	const expected =
		c.env?.CORELIB_API_TOKEN || globalThis.process?.env?.CORELIB_API_TOKEN;

	if (!expected) {
		c.get("logger")?.error("auth: CORELIB_API_TOKEN is not configured", {
			path: c.req.path,
		});
		return c.json(
			{
				status: "error",
				reason: { message: "Service authentication is not configured" },
			},
			503,
		);
	}

	const presented = /^Bearer (.+)$/i.exec(
		c.req.header("authorization") ?? "",
	)?.[1];
	if (!presented || !(await safeEqual(presented, expected))) {
		return c.json(
			{ status: "error", reason: { message: "Unauthorized" } },
			401,
			{ "WWW-Authenticate": 'Bearer realm="corelib"' },
		);
	}
	return next();
});
