// =============================================
// FILE: ts-markets/src/index.ts
// PURPOSE: Optional package (ts-markets)
// Can be imported separately: import { Markets } from '@ckir/corelib-markets'
// =============================================

import {
	ApiNasdaqUnlimited,
	type NasdaqResult,
} from "./nasdaq/ApiNasdaqUnlimited";

export { ApiNasdaqUnlimited, type NasdaqResult };

export const Markets = {
	nasdaq: { ApiNasdaqUnlimited },
};

export { YahooStreaming } from "./nasdaq/datafeeds/streaming/yahoo/YahooStreaming";
// Update to ts-markets/src/index.ts (add to end)
export { MarketStatus, type NasdaqMarketInfo } from "./nasdaq/MarketStatus";
