/**
 * @file ts-cloud/src/core/router.ts
 * @description Central router for ts-cloud.
 * Orchestrates the exposure of corelib functionality via a versioned API (/api/v1/).
 * Optimized for deployment on edge environments (Cloudflare Workers, AWS Lambda, etc.).
 */

import type { StrictLogger } from "@ckir/corelib";
import { Hono } from "hono";
import { sqlRouter } from "../database/SqlCloud";
import { nasdaqRouter } from "../markets/nasdaq/ApiNasdaqUnlimitedCloud";
import { marketStatusRouter } from "../markets/nasdaq/MarketStatusCloud";
import { kyRouter } from "../retrieve/RequestUnlimitedCloud";
import type { AppEnv } from "./types";

/**
 * Factory function to create and configure the main Hono application.
 * This setup includes health checks and versioned routing for corelib modules.
 * @param {StrictLogger} [logger] Optional logger instance to use for request logging.
 * @returns {Hono<AppEnv>} The configured Hono application instance.
 */
export const createRouter = (logger?: StrictLogger): Hono<AppEnv> => {
	const app = new Hono<AppEnv>();

	/**
	 * Inject environment variables and set logger
	 */
	app.use("*", async (c, next) => {
		if (logger) {
			c.set("logger", logger);
		}

		// Ensure c.env exists (Hono Context.env can be undefined in Node if not passed)
		(c as any).env = c.env || {};

		// Inject process.env into c.env if not already there
		c.env.CORELIB_TURSO_URL =
			c.env.CORELIB_TURSO_URL || process.env.CORELIB_TURSO_URL || "";
		c.env.CORELIB_TURSO_TOKEN =
			c.env.CORELIB_TURSO_TOKEN || process.env.CORELIB_TURSO_TOKEN || "";
		c.env.PLATFORM = c.env.PLATFORM || "aws-lambda";

		// Optional: Console log for debugging local SAM runs
		if (process.env.MODE === "development") {
			console.log("DEBUG ENV URL:", c.env.CORELIB_TURSO_URL);
			console.log(
				"DEBUG ENV TOKEN:",
				c.env.CORELIB_TURSO_TOKEN ? "present" : "missing",
			);
		}

		await next();
	});

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
	 * Health Check (v1)
	 */
	apiV1.get("/health", (c) => {
		return c.json({
			status: "ok",
			timestamp: new Date().toISOString(),
			service: "ts-cloud",
			version: "v1",
		});
	});

	/**
	 * RequestUnlimited (ky) Endpoint
	 */
	apiV1.route("/ky", kyRouter);

	/**
	 * Nasdaq Market Data Endpoints
	 * Exposes corelib-markets' resilient Nasdaq API fetching logic.
	 * /markets/nasdaq (POST) handles proxy requests.
	 * /markets/nasdaq/status (GET) handles market status fetching.
	 */
	apiV1.route("/markets/nasdaq", nasdaqRouter);
	apiV1.route("/markets/nasdaq/status", marketStatusRouter);

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
