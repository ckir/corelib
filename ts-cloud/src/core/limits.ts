/**
 * @file ts-cloud/src/core/limits.ts
 * @description Shared request limits for the proxy routers.
 */

import type { Context } from "hono";

/** Maximum number of entries accepted in one bulk request array. */
export const MAX_BULK = 20;

/**
 * Returns a 400 response when a bulk array exceeds {@link MAX_BULK}, else undefined.
 * Must be called before any outbound work is started.
 */
export function rejectOversizedBulk(
	c: Context,
	entries: readonly unknown[],
): Response | undefined {
	if (entries.length > MAX_BULK) {
		return c.json(
			{
				status: "error",
				reason: { message: `Too many endPoints (max ${MAX_BULK})` },
			},
			400,
		);
	}
	return undefined;
}
