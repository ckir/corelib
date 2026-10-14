// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/types.ts
// PURPOSE: Payload types for the streaming wrappers. These mirror the N-API declarations in
// rust/index.d.ts (the source of truth for what the native side emits); index.types.test.ts enforces it.
// The native class/constructor types live in @ckirg/corelib (ts-core/src/core/ffi-types.ts).
// =============================================

/** Alpaca pricing payload (trade, quote or bar) as emitted by the native streamer. */
export interface AlpacaPricingData {
	/** Ticker symbol, e.g. "AAPL". */
	symbol: string;
	/** Kind of update: "quote", "trade" or "bar". */
	messageType: string;
	/** Last trade price, bar close, or bid price for quotes. */
	price: number;
	bidPrice: number;
	askPrice: number;
	volume: number;
	/** Exchange timestamp as provided by Alpaca. */
	timestamp: string;
}

/** Yahoo pricing payload (native `JsPricingData`). */
export interface YahooPricingData {
	id: string;
	price: number;
	/** Unix milliseconds. */
	time: number;
	currency: string;
	exchange: string;
	quoteType: number;
	marketHours: number;
	changePercent: number;
	dayVolume: number;
	dayHigh: number;
	dayLow: number;
	change: number;
	shortName: string;
	expireDate: number;
	openPrice: number;
	previousClose: number;
	strikePrice: number;
	underlyingSymbol: string;
	openInterest: number;
	optionType: number;
	miniOption: number;
	lastSize: number;
	bidPrice: number;
	bidSize: number;
	askPrice: number;
	askSize: number;
	priceHint: number;
	vol24Hr: number;
	volAllCurrencies: number;
	fromCurrency: string;
	lastMarket: string;
	circulatingSupply: number;
	marketCap: number;
}

/** Finnhub trade payload as typed by this package. */
export interface FinnhubPricingData {
	symbol: string;
	messageType: string;
	price: number;
	volume: number;
	timestamp: number;
	conditions?: string[];
}
