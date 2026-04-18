// =============================================
// FILE: ts-markets/src/index.ts
// PURPOSE: Optional package (ts-markets)
// Can be imported separately: import { Markets } from '@ckir/corelib-markets'
// =============================================

import {
	ApiNasdaqQuotes,
	type ApiNasdaqQuotesOptions,
} from "./nasdaq/ApiNasdaqQuotes";
import {
	ApiNasdaqUnlimited,
	getNasdaqHeaders,
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
	ApiNasdaqQuotes,
	type ApiNasdaqQuotesOptions,
	ApiNasdaqUnlimited,
	CnnFearAndGreed,
	CnnFearAndGreedFilter,
	type CnnFilterInput,
	type CnnResult,
	getNasdaqHeaders,
	type NasdaqResult,
};

export const Markets = {
	nasdaq: { ApiNasdaqUnlimited, ApiNasdaqQuotes, MarketSymbols },
};

export * as Luxon from "luxon";
export { NasdaqPolling } from "./nasdaq/datafeeds/polling/nasdaq/NasdaqPolling";
export { AlpacaStreaming } from "./nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming";
export { YahooStreaming } from "./nasdaq/datafeeds/streaming/yahoo/YahooStreaming";
export { getSymbolsTop100 } from "./nasdaq/groups/Top100";
export { MarketMonitor, type MarketPhase } from "./nasdaq/MarketMonitor";
export { MarketStatus, type NasdaqMarketInfo } from "./nasdaq/MarketStatus";
export { type MarketSymbolRow, MarketSymbols };
