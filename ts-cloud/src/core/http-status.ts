/**
 * @file ts-cloud/src/core/http-status.ts
 * @description Status-code helpers that keep Hono's c.json from throwing or sending bodiless responses.
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Maps an arbitrary status code to a Hono-compatible ContentfulStatusCode.
 * 1xx, 204, 205, 304 (bodiless) and out-of-range / non-integer values map to 200.
 */
export function toContentfulStatus(code: number): ContentfulStatusCode {
	const isNonContentful =
		(code >= 100 && code < 200) || [204, 205, 304].includes(code);

	if (isNonContentful || !Number.isInteger(code) || code < 100 || code > 599) {
		return 200;
	}

	return code as ContentfulStatusCode;
}

/**
 * Derives the response status for an error reason: its numeric `status` when it is a
 * valid contentful code, otherwise 500.
 */
export function errorStatus(reason: unknown): ContentfulStatusCode {
	const status = (reason as { status?: unknown } | null | undefined)?.status;
	if (typeof status !== "number" || !Number.isInteger(status)) return 500;
	const mapped = toContentfulStatus(status);
	// toContentfulStatus maps invalid/bodiless codes to 200, which is wrong for an error.
	return mapped === 200 && status !== 200 ? 500 : mapped;
}
