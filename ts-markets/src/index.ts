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

import { type MarketSymbolRow, MarketSymbols } from "./nasdaq/MarketSymbols";

export {
	ApiNasdaqUnlimited,
	CnnFearAndGreed,
	CnnFearAndGreedFilter,
	type CnnFilterInput,
	type CnnResult,
	type NasdaqResult,
};

export const Markets = {
	nasdaq: { ApiNasdaqUnlimited, MarketSymbols },
};

export { YahooStreaming } from "./nasdaq/datafeeds/streaming/yahoo/YahooStreaming";
export { MarketMonitor, type MarketPhase } from "./nasdaq/MarketMonitor";
export { MarketStatus, type NasdaqMarketInfo } from "./nasdaq/MarketStatus";
export { type MarketSymbolRow, MarketSymbols };
export * as Luxon from "luxon";

