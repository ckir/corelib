// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/types.ts
// PURPOSE: Payload and native-class types for the streaming wrappers. These mirror the
// N-API declarations in rust/index.d.ts (the source of truth for what the native side emits).
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
	message_type: string;
	price: number;
	volume: number;
	timestamp: number;
	conditions?: string[];
}
/** Log record delivered by the native side. */
export interface NativeLogRecord {
	level: string;
	msg: string;
	extras?: string;
}

/** Lifecycle event delivered by the native side. */
export interface NativeEventRecord {
	type: string;
	data?: string;
}

type ErrFirst<T> = (err: Error | null, value: T) => unknown;

/** Native Yahoo streamer class (constructor-visible shape). */
export interface YahooStreamingNative {
	init(config: {
		dbPath?: string;
		silenceSeconds?: number;
		baseUrl?: string;
	}): Promise<void>;
	start(): Promise<void>;
	subscribe(symbols: string[]): Promise<void>;
	unsubscribe(symbols: string[]): Promise<void>;
	clean(): Promise<void>;
	stop(): Promise<void>;
}

/** Constructor of the native Yahoo streamer. */
export interface YahooStreamingNativeConstructor {
	new (
		onLog: ErrFirst<NativeLogRecord>,
		onPricing: ErrFirst<YahooPricingData>,
		onEvent: ErrFirst<NativeEventRecord>,
		onMarketEvent?: ErrFirst<string> | null,
	): YahooStreamingNative;
}

/** Native Finnhub streamer class (constructor-visible shape). */
export interface FinnhubStreamingNative {
	init(config: {
		token?: string;
		name?: string;
		baseUrl?: string;
	}): Promise<void>;
	start(): Promise<void>;
	subscribe(symbols: string[]): Promise<void>;
	unsubscribe(symbols: string[]): Promise<void>;
	stop(): Promise<void>;
	clean(): Promise<void>;
}

/** Constructor of the native Finnhub streamer. */
export interface FinnhubStreamingNativeConstructor {
	new (
		onLog: ErrFirst<NativeLogRecord>,
		onPricing: ErrFirst<FinnhubPricingData>,
		onEvent: ErrFirst<NativeEventRecord>,
		onMarketEvent?: ErrFirst<string> | null,
	): FinnhubStreamingNative;
}
