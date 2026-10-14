/**
 * @file ts-cloud/src/database/SqlCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib's createDatabase logic.
 */

import type { SqliteConfig } from "@ckirg/corelib";
import { createDatabase } from "@ckirg/corelib";
import { type Context, Hono } from "hono";
import { serializeError } from "serialize-error";
import { getRequestId } from "../core/request-context";
import type { AppEnv } from "../core/types";

/**
 * Hono router for SQL query execution.
 * Mounted at /api/v1/sql in the main application.
 */
export const sqlRouter = new Hono<AppEnv>();

/**
 * Middleware to inject a child logger for SQL operations.
 */
sqlRouter.use("*", async (c, next) => {
	const parentLogger = c.get("logger");
	const sqlLogger = parentLogger?.child({ section: "SqlCloud" });
	if (sqlLogger) c.set("logger", sqlLogger);
	await next();
});

/** `params` may be omitted, a positional array, or a plain named-parameter object. */
function isValidParams(params: unknown): boolean {
	if (params === undefined || Array.isArray(params)) return true;
	if (typeof params !== "object" || params === null) return false;
	const proto = Object.getPrototypeOf(params);
	return proto === Object.prototype || proto === null;
}

/**
 * POST /
 * Executes a parameterized SQL query using createDatabase from @ckirg/corelib.
 * Uses CORELIB_TURSO_URL and CORELIB_TURSO_TOKEN from environment.
 */
sqlRouter.post("/", async (c: Context<AppEnv>): Promise<Response> => {
	try {
		const body = await c.req.json().catch(() => null);

		if (!body) {
			c.get("logger")?.debug("sql: rejected", { reason: "missing body" });
			return c.json(
				{ status: "error", reason: { message: "Missing request body" } },
				400,
			);
		}

		const { sql, params } = body;

		c.get("logger")?.debug("sql: request", {
			hasSql: sql != null,
			hasParams: params != null,
		});

		if (typeof sql !== "string" || !sql.trim()) {
			c.get("logger")?.debug("sql: rejected", { reason: "missing sql" });
			return c.json(
				{
					status: "error",
					reason: { message: "Missing SQL query" },
				},
				400,
			);
		}

		if (!isValidParams(params)) {
			c.get("logger")?.debug("sql: rejected", { reason: "invalid params" });
			return c.json(
				{
					status: "error",
					reason: { message: "Invalid params: expected an array or an object" },
				},
				400,
			);
		}

		const bindings = c.env;
		const logger = c.get("logger");

		const dbConfig: SqliteConfig = {
			dialect: "sqlite",
			mode: "stateless",
			url: bindings.CORELIB_TURSO_URL,
			authToken: bindings.CORELIB_TURSO_TOKEN,
			logger,
			// Flight-recorder: stamp this request's rid onto the query logs as traceId, so
			// an AI can tie a SQL query back to the request that issued it. Undefined outside
			// a request context (Tier-3 omits traceId cleanly).
			getTraceId: () => {
				const rid = getRequestId();
				return rid != null ? String(rid) : undefined;
			},
		};
		// One client per request (credentials are per-env); always released in finally.
		const db = await createDatabase(dbConfig);
		try {
			const result = await db.query(sql, params);
			logger?.debug("sql: ok", { status: result?.status });
			return c.json(result);
		} finally {
			try {
				await db.disconnect();
			} catch (disconnectError) {
				logger?.warn("sql: disconnect failed", { error: disconnectError });
			}
		}
	} catch (error) {
		const logger = c.get("logger");
		logger?.error("SQL Sub-Router Error", { error: serializeError(error) });
		return c.json(
			{ status: "error", reason: { message: "Internal SQL Error" } },
			500,
		);
	}
});
