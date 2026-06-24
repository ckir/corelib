// =============================================
// FILE: ts-cloud/src/index.ts
// PURPOSE: Optional package (ts-cloud)
// Can be imported separately: import { Cloud } from '@ckirg/corelib-cloud'
// =============================================

import { createRouter } from "./core/router";
import { sqlRouter } from "./database/SqlCloud";
import { nasdaqRouter } from "./markets/nasdaq/ApiNasdaqUnlimitedCloud";
import { historicalRouter } from "./markets/nasdaq/HistoricalCloud";
import { marketStatusRouter } from "./markets/nasdaq/MarketStatusCloud";
import { kyRouter } from "./retrieve/RequestUnlimitedCloud";

export {
	createRouter,
	historicalRouter,
	kyRouter,
	marketStatusRouter,
	nasdaqRouter,
	sqlRouter,
};

/**
 * Main entry point for the Cloud package.
 * Groups all edge-compatible routers and utilities.
 */
export const Cloud = {
	/**
	 * Factory function to create the main Hono router.
	 */
	createRouter,
	/**
	 * Nasdaq market data routers.
	 */
	nasdaq: {
		/**
		 * Router for high-performance Nasdaq API proxying.
		 */
		unlimited: nasdaqRouter,
		/**
		 * Router for historical data fetching.
		 */
		historical: historicalRouter,
		/**
		 * Router for market status information.
		 */
		status: marketStatusRouter,
	},
	/**
	 * Router for generic HTTP proxying via RequestUnlimited.
	 */
	ky: kyRouter,
	/**
	 * Router for SQL query execution (Turso/LibSQL).
	 */
	sql: sqlRouter,
};

export type { AppEnv } from "./core/types";
