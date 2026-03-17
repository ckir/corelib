// =============================================
// FILE: ts-markets/src/index.ts
// PURPOSE: Optional package (ts-markets)
// Can be imported separately: import { Markets } from '@ckir/corelib-markets'
// =============================================

import {
	ApiNasdaqUnlimited,
	type NasdaqResult,
} from "./nasdaq/ApiNasdaqUnlimited";

import {
	CnnFearAndGreed,
	CnnFearAndGreedFilter,
	type CnnFilterInput,
	type CnnResult,
} from "./nasdaq/CnnFearAndGreed";

export { ApiNasdaqUnlimited, type NasdaqResult };
export {
	CnnFearAndGreed,
	type CnnResult,
	type CnnFilterInput,
	CnnFearAndGreedFilter,
};

export const Markets = {
	nasdaq: { ApiNasdaqUnlimited },
};

export { YahooStreaming } from "./nasdaq/datafeeds/streaming/yahoo/YahooStreaming";
export { MarketMonitor, type MarketPhase } from "./nasdaq/MarketMonitor";
export { MarketStatus, type NasdaqMarketInfo } from "./nasdaq/MarketStatus";
