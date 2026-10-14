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
 * Instance side of the native streaming classes. These must equal the classes napi generates in
 * rust/index.d.ts; ffi-types.test.ts enforces that at typecheck time. Every method returns a promise.
 */
export interface AlpacaStreamingFFI {
	/** Initialize with config object */
	init(config: AlpacaConfig): Promise<void>;
	/** Start the streaming connection */
	start(): Promise<void>;
	/** Subscribe to symbols per channel */
	subscribe(opts: AlpacaSubscribeOpts): Promise<void>;
	/** Unsubscribe from symbols per channel */
	unsubscribe(opts: AlpacaSubscribeOpts): Promise<void>;
	/** Clean local state/database */
	clean(): Promise<void>;
	/** Stop the streaming connection */
	stop(): Promise<void>;
}

export interface YahooStreamingFFI {
	init(config: YahooConfig): Promise<void>;
	start(): Promise<void>;
	subscribe(symbols: string[]): Promise<void>;
	unsubscribe(symbols: string[]): Promise<void>;
	clean(): Promise<void>;
	stop(): Promise<void>;
}

export interface FinnhubStreamingFFI {
	init(config: FinnhubConfig): Promise<void>;
	start(): Promise<void>;
	subscribe(symbols: string[]): Promise<void>;
	unsubscribe(symbols: string[]): Promise<void>;
	stop(): Promise<void>;
	clean(): Promise<void>;
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
	baseUrl?: string;
}

export interface FinnhubConfig {
	token?: string;
	name?: string;
	baseUrl?: string;
}

// =============================================
// Streaming Types
// =============================================

export interface AlpacaSubscribeOpts {
	trades?: string[];
	quotes?: string[];
	bars?: string[];
}

export interface LogRecord {
	level: string;
	msg: string;
	/** JSON-serialized extras, as delivered by native. */
	extras?: string;
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
	/** Event type, e.g. "connected", "disconnected", "reconnecting", "error". */
	type: string;
	/** Optional metadata or error message. */
	data?: string;
}
