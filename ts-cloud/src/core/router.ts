/**
 * @file ts-cloud/src/core/router.ts
 * @description Central router for ts-cloud.
 * Orchestrates the exposure of corelib functionality via a versioned API (/api/v1/).
 * Optimized for deployment on edge environments (Cloudflare Workers, AWS Lambda, etc.).
 */

import { Hono } from "hono";
import { sqlRouter } from "../database/SqlCloud";
import { nasdaqRouter } from "../markets/nasdaq/ApiNasdaqUnlimitedCloud";
import { kyRouter } from "../retrieve/RequestUnlimitedCloud";
import type { AppEnv } from "./types";

/**
 * Factory function to create and configure the main Hono application.
 * This setup includes health checks and versioned routing for corelib modules.
 * * @returns {Hono<AppEnv>} The configured Hono application instance.
 */
export const createRouter = (): Hono<AppEnv> => {
	const app = new Hono<AppEnv>();

	/**
	 * Health Check
	 * Simple endpoint to verify the service is running on the edge.
	 */
	app.get("/health", (c) => {
		return c.json({
			status: "ok",
			timestamp: new Date().toISOString(),
			service: "ts-cloud",
		});
	});

	/**
	 * API v1 Routes
	 * All corelib functionality is grouped under the /api/v1/ prefix.
	 */
	const apiV1 = new Hono<AppEnv>();

	/**
	 * RequestUnlimited (ky) Endpoint
	 * Exposes corelib's resilient fetching logic.
	 */
	apiV1.route("/ky", kyRouter);

	/**
	 * Nasdaq Market Data Endpoint
	 * Exposes corelib-markets' resilient Nasdaq API fetching logic.
	 */
	apiV1.route("/markets/nasdaq", nasdaqRouter);

	/**
	 * SQL Query (Turso) Endpoint
	 * Executes a parametrized query using createDatabase from @ckir/corelib.
	 */
	apiV1.route("/sql", sqlRouter);

	// Mount the versioned API to the main application
	app.route("/api/v1", apiV1);

	/**
	 * Global Error Handler
	 * Captures unhandled exceptions within the router and logs them.
	 */
	app.onError((err, c) => {
		const logger = c.get("logger");
		logger?.error("Unhandled Router Error", {
			error: err.message,
			stack: err.stack,
			path: c.req.path,
		});

		return c.json(
			{
				status: "error",
				reason: { message: "Internal Server Error" },
			},
			500,
		);
	});

	/**
	 * 404 Not Found Handler
	 */
	app.notFound((c) => {
		return c.json(
			{
				status: "error",
				reason: { message: `Route not found: ${c.req.method} ${c.req.path}` },
			},
			404,
		);
	});

	return app;
};
