// =============================================
// FILE: ts-core/src/core/ffi-types.ts
// PURPOSE: Type definitions for the Rust FFI interface (coreFFI)
// These types mirror the N-API exports from rust/src/lib.rs
// =============================================

/**
 * Base FFI interface that all native modules must implement.
 * The actual implementation is loaded dynamically from the native binary.
 */
export interface CoreFFI {
	/** Simple test function: logs in Rust and returns doubled value */
	logAndDouble?: (msg: string, value: number) => number;
	/** Returns the native library version */
	getVersion?: () => string;

	// Streaming modules (conditionally available) - these are constructors
	AlpacaStreaming?: AlpacaStreamingConstructor;
	YahooStreaming?: YahooStreamingConstructor;
	FinnhubStreaming?: FinnhubStreamingConstructor;
}

/**
 * Constructor type for AlpacaStreaming - matches the N-API class export
 */
export interface AlpacaStreamingConstructor {
	new (
		logCallback: (err: unknown, record: LogRecord) => void,
		pricingCallback: (err: unknown, data: AlpacaPricingData) => void,
		eventCallback: (err: unknown, event: StreamingEvent) => void,
		marketCallback: (err: unknown, json: string) => void,
	): AlpacaStreamingFFI;
}

/**
 * Constructor type for YahooStreaming - matches the N-API class export
 */
export interface YahooStreamingConstructor {
	new (
		logCallback: (err: unknown, record: LogRecord) => void,
		pricingCallback: (err: unknown, data: YahooPricingData) => void,
		eventCallback: (err: unknown, event: StreamingEvent) => void,
		marketCallback: (err: unknown, json: string) => void,
	): YahooStreamingFFI;
}

/**
 * Constructor type for FinnhubStreaming - matches the N-API class export
 */
export interface FinnhubStreamingConstructor {
	new (
		logCallback: (err: unknown, record: LogRecord) => void,
		pricingCallback: (err: unknown, data: FinnhubPricingData) => void,
		eventCallback: (err: unknown, event: StreamingEvent) => void,
		marketCallback: (err: unknown, json: string) => void,
	): FinnhubStreamingFFI;
}

/**
 * Alpaca Streaming FFI interface
 * Mirrors rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs
 */
export interface AlpacaStreamingFFI {
	/** Initialize with config object */
	init: (config: AlpacaConfig) => Promise<void>;
	/** Start the streaming connection */
	start: () => Promise<void>;
	/** Stop the streaming connection */
	stop: () => void;
	/** Subscribe to symbols */
	subscribe: (opts: AlpacaSubscribeOpts) => void;
	/** Unsubscribe from symbols */
	unsubscribe: (opts: AlpacaSubscribeOpts) => void;
	/** Clean local state/database */
	clean: () => void;
	/** Set log callback */
	setLogCallback?: (callback: (record: LogRecord) => void) => void;
	/** Set pricing callback */
	setPricingCallback?: (callback: (data: AlpacaPricingData) => void) => void;
	/** Set event callback */
	setEventCallback?: (callback: (event: StreamingEvent) => void) => void;
	/** Set market callback */
	setMarketCallback?: (callback: (json: string) => void) => void;
}

/**
 * Yahoo Streaming FFI interface
 * Mirrors rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs
 */
export interface YahooStreamingFFI {
	init: (config: YahooConfig) => Promise<void>;
	start: () => Promise<void>;
	stop: () => void;
	subscribe: (opts: YahooSubscribeOpts) => void;
	unsubscribe: (opts: YahooSubscribeOpts) => void;
	clean: () => void;
	setLogCallback?: (callback: (record: LogRecord) => void) => void;
	setPricingCallback?: (callback: (data: YahooPricingData) => void) => void;
	setEventCallback?: (callback: (event: StreamingEvent) => void) => void;
	setMarketCallback?: (callback: (json: string) => void) => void;
}

/**
 * Finnhub Streaming FFI interface (optional feature)
 * Mirrors rust/src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_streamer.rs
 */
export interface FinnhubStreamingFFI {
	init: (config: FinnhubConfig) => Promise<void>;
	start: () => Promise<void>;
	stop: () => void;
	subscribe: (opts: FinnhubSubscribeOpts) => void;
	unsubscribe: (opts: FinnhubSubscribeOpts) => void;
	clean: () => void;
	setLogCallback?: (callback: (record: LogRecord) => void) => void;
	setPricingCallback?: (callback: (data: FinnhubPricingData) => void) => void;
	setEventCallback?: (callback: (event: StreamingEvent) => void) => void;
	setMarketCallback?: (callback: (json: string) => void) => void;
}

// =============================================
// Config Types
// =============================================

export interface AlpacaConfig {
	dbPath?: string;
	silenceSeconds?: number;
	baseUrl?: string;
	keyId?: string;
	secretKey?: string;
}

export interface YahooConfig {
	dbPath?: string;
	silenceSeconds?: number;
	symbols?: string[];
	noPersist?: boolean;
}

export interface FinnhubConfig {
	token: string;
	dbPath?: string;
	silenceSeconds?: number;
	symbols?: string[];
}

// =============================================
// Streaming Types
// =============================================

export interface AlpacaSubscribeOpts {
	trades?: string[];
	quotes?: string[];
	bars?: string[];
}

export interface YahooSubscribeOpts {
	symbols: string[];
}

export interface FinnhubSubscribeOpts {
	symbols: string[];
}

export interface LogRecord {
	level: string;
	msg: string;
	extras?: Record<string, unknown>;
}

// The pricing payload interfaces below must equal the typings napi generates for the Rust structs
// (rust/index.d.ts); ffi-types.test.ts enforces that at typecheck time.

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

/** Yahoo pricing payload (the native struct is exported by napi as `JsPricingData`). */
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

/**
 * Finnhub trade payload delivered to the native pricing callback. Must equal the typing napi generates
 * for the Rust struct (rust/index.d.ts); ffi-types.test.ts enforces that at typecheck time.
 */
export interface FinnhubPricingData {
	symbol: string;
	messageType: string;
	price: number;
	volume: number;
	timestamp: number;
	conditions?: string[];
}

export interface StreamingEvent {
	type:
		| "connected"
		| "disconnected"
		| "reconnecting"
		| "silence-reconnect"
		| "error";
	data?: Record<string, unknown>;
}
