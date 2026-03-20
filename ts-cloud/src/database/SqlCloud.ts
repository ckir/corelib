/**
 * @file ts-cloud/src/database/SqlCloud.ts
 * @description Edge-compatible Hono sub-router exposing corelib's createDatabase logic.
 */

import { createDatabase } from "@ckir/corelib";
import { Hono } from "hono";
import type { AppEnv } from "../core/types";

export const sqlRouter = new Hono<any>();

/**
 * POST /
 * Executes a parameterized SQL query using createDatabase from @ckir/corelib.
 * Uses CORELIB_TURSO_URL and CORELIB_TURSO_TOKEN from environment.
 */
sqlRouter.post("/", async (c: any) => {
	try {
		const { sql, params } = await c.req.json();

		if (!sql) {
			return c.json(
				{ status: "error", reason: { message: "Missing SQL query" } },
				400,
			);
		}

		const bindings = c.env as AppEnv["Bindings"];
		const logger = c.get("logger") as AppEnv["Variables"]["logger"];

		const db = await createDatabase({
			dialect: "sqlite",
			mode: "stateless",
			url: bindings.CORELIB_TURSO_URL,
			authToken: bindings.CORELIB_TURSO_TOKEN,
			logger: logger,
		} as any);

		const result = await db.query(sql, params);
		return c.json(result);
	} catch (error) {
		const logger = c.get("logger") as AppEnv["Variables"]["logger"];
		logger?.error("SQL Sub-Router Error", { error });
		return c.json(
			{ status: "error", reason: { message: "Internal SQL Error" } },
			500,
		);
	}
});
