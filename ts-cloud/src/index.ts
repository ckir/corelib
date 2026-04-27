// =============================================
// FILE: ts-cloud/src/index.ts
// PURPOSE: Optional package (ts-cloud)
// Can be imported separately: import { Cloud } from '@ckir/corelib-cloud'
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

export const Cloud = {
	createRouter,
	nasdaq: {
		unlimited: nasdaqRouter,
		historical: historicalRouter,
		status: marketStatusRouter,
	},
	ky: kyRouter,
	sql: sqlRouter,
};

export type { AppEnv } from "./core/types";
