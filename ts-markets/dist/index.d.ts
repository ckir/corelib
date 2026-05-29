import * as ky from 'ky';
import { Options } from 'ky';
import { Database, StrictLogger } from '@ckir/corelib';
import * as luxon from 'luxon';
export { luxon as Luxon };
import { EventEmitter } from 'node:events';

/**
 * Result pattern for Nasdaq API calls.
 * @template T The type of the value on success.
 */
type NasdaqResult<T = unknown> = {
    /** Indicates a successful request and logic check. */
    status: "success";
    /** The data returned by the API (usually the contents of the 'data' field). */
    value: T;
    /** Optional details about the response (headers, status, etc.). */
    details?: unknown;
} | {
    /** Indicates a transport error or an API-level logic error. */
    status: "error";
    /** The reason for the failure. */
    reason: {
        message: string;
        [key: string]: unknown;
    };
};
/**
 * Generates spoofed headers for Nasdaq API requests to ensure compatibility.
 * Dynamically handles differences between standard API calls and charting-specific endpoints.
 *
 * @param {string} url - The URL of the request.
 * @returns {Record<string, string>} A dictionary of headers.
 */
declare function getNasdaqHeaders(url: string): Record<string, string>;
/**
 * Executes a single Nasdaq API request with automatic header spoofing and logic check.
 *
 * @template T The expected type of the data returned in the 'data' field.
 * @param {string | URL | Request} url - The URL or request object.
 * @param {Options} [options] - Additional request options (passed to ky).
 * @returns {Promise<NasdaqResult<T>>} A promise resolving to a NasdaqResult.
 */
declare function nasdaqEndPoint<T = unknown>(url: string | URL | Request, options?: Options): Promise<NasdaqResult<T>>;
/**
 * Executes multiple Nasdaq API requests in parallel.
 *
 * @template T The expected type of the data returned by each request.
 * @param {(string | URL | Request)[]} urls - Array of URLs or request objects.
 * @param {Options} [options] - Additional request options.
 * @returns {Promise<NasdaqResult<T>[]>} A promise resolving to an array of NasdaqResults.
 */
declare function nasdaqEndPoints<T = unknown>(urls: (string | URL | Request)[], options?: Options): Promise<NasdaqResult<T>[]>;
/**
 * Nasdaq API integration section.
 */
declare const ApiNasdaqUnlimited: {
    /**
     * Executes a single Nasdaq API request.
     */
    endPoint: typeof nasdaqEndPoint;
    /**
     * Executes multiple Nasdaq API requests in parallel.
     */
    endPoints: typeof nasdaqEndPoints;
};

/**
 * Represents a single row in the Nasdaq symbols database.
 */
interface MarketSymbolRow {
    /** Trading symbol (ticker). */
    symbol: string;
    /** Human-readable name of the security. */
    name: string;
    /** Data type: 'rt' (real-time) or 'eod' (end-of-day). */
    type: "rt" | "eod";
    /** Asset class (e.g., 'stocks', 'etf'). */
    class: string;
    /** Last updated timestamp (Unix milliseconds). */
    ts: number;
    /** Indicates if the symbol is currently active. */
    active: boolean;
}
/**
 * Nasdaq symbol database using ts-core SQLite (local or Turso) alongside API & Ingestor fallbacks.
 *
 * Automatically refreshes on first use or when data is older than today (NY time).
 * Modifies search hierarchy (DB vs API) dynamically based on edge vs non-edge runtimes.
 */
declare class MarketSymbols {
    private readonly ingestors;
    private db;
    private initialized;
    private isDbOwner;
    private readonly config?;
    /**
     * Registry mapping URL patterns to specific ingestor methods.
     * Designed to be "open" for additional ingestors in future releases.
     */
    private readonly ingestorRegistry;
    /**
     * @param db - Optional database configuration or existing instance:
     * - `undefined` → uses `${getTempDir()}/NasdaqSymbols.sqlite`
     * - `string` → local SQLite file path
     * - `{ dbUrl: string; dbToken: string }` → Turso/LibSQL remote
     * - `Database` → An existing instance of a Database driver
     * @param ingestors - Array of ingestor URLs (e.g., Google App Script endpoints) to query for missing symbols.
     */
    constructor(db?: string | {
        dbUrl: string;
        dbToken: string;
    } | Database, ingestors?: string[]);
    /**
     * Force a full refresh of the symbol database.
     * Called automatically on first use if needed.
     */
    refresh(): Promise<void>;
    /**
     * Get symbol data.
     * Searches Nasdaq API, external ingestors, and the DB. The sequence order is
     * optimized dynamically based on whether it is running in an Edge environment.
     * @returns `null` if the symbol is not found or is inactive.
     */
    get(symbol: string): Promise<MarketSymbolRow | null>;
    /**
     * Graceful shutdown – disconnects the database driver if it was created internally.
     */
    close(): Promise<void>;
    /**
     * Queries the official Nasdaq autocomplete API for a symbol.
     * Filters for an exact match.
     */
    private searchNasdaqApi;
    /**
     * Queries external ingestors defined in the constructor based on the internal registry pattern.
     */
    private searchIngestors;
    /**
     * Specifically processes Google Apps Script (GAS) ingestor URLs.
     */
    private ingestorGAS;
    /**
     * Searches the local or remote SQLite database.
     */
    private searchDb;
    /**
     * Initializes the database driver if not already done.
     * Creates the `nasdaq_symbols` table if it doesn't exist.
     * Creates an index on the `active` column if it doesn't exist.
     * Called automatically on first use, and before any other operations.
     */
    private ensureInitialized;
    /**
     * Checks if the database needs to be refreshed.
     * Returns true if the database has never been populated, or if the last refresh was not today.
     * @returns {Promise<boolean>} true if the database needs to be refreshed
     */
    private needsRefresh;
    /**
     * Refreshes the symbol database.
     * Only runs if the database has never been populated, or if the last refresh was not today.
     * Downloads the official Nasdaq symbol directories, parses them, and updates the database.
     * @returns {Promise<void>} resolves after the database has been refreshed
     */
    private performRefresh;
    /**
     * Downloads the official Nasdaq symbol directories with retry and circuit breaker.
     * Retries with exponential backoff up to `markets.nasdaq.symbols.maxRetryBackoffMs` per interval.
     * Stops after `markets.nasdaq.symbols.maxFetchRetries` consecutive failures even when existing data is present.
     * Throws immediately on first failure when no existing data exists.
     */
    private fetchSymbolFilesWithRetry;
    /**
     * Checks if there is existing data in the database.
     * Returns true if there is any existing data, false otherwise.
     * @returns {Promise<boolean>} true if there is any existing data, false otherwise
     */
    private hasExistingData;
    /**
     * Parses the official Nasdaq symbol directory file (nasdaqlisted.txt).
     * Skips the first two lines (header) and empty lines.
     * Skips lines with less than 8 fields (invalid).
     * Extracts the symbol, name, and ETF status from the line.
     * Creates a MarketSymbolRow with the extracted data and adds it to the result array.
     * @param {string} text - The content of the nasdaqlisted.txt file as a string
     * @returns {MarketSymbolRow[]} - An array of MarketSymbolRow objects parsed from the file
     */
    private parseNasdaqListed;
    /**
     * Parses the official Nasdaq symbol directory file (otherlisted.txt).
     * Skips the first two lines (header) and empty lines.
     * Skips lines with less than 5 fields (invalid).
     * Extracts the symbol, name, and ETF status from the line.
     * Creates a MarketSymbolRow with the extracted data and adds it to the result array.
     * @param {string} text - The content of the otherlisted.txt file as a string
     * @returns {MarketSymbolRow[]} - An array of MarketSymbolRow objects parsed from the file
     */
    private parseOtherListed;
}

/**
 * Configuration options for the ApiNasdaqQuotes module.
 */
interface ApiNasdaqQuotesOptions {
    /** Standardized logger for error and warning reporting */
    logger?: StrictLogger;
    /** Optional list of proxy URLs. If provided, requests will be routed through RequestProxied */
    proxies?: string[];
    /** Optional instance of MarketSymbols. If not provided, a new one will be created internally */
    marketSymbols?: MarketSymbols;
    /** Concurrency limit for non-proxied requests to prevent Nasdaq rate limiting. Defaults to 5 */
    concurrencyLimit?: number;
}
/**
 * ApiNasdaqQuotes handles fetching ticker info and quotes from the unofficial Nasdaq API.
 * It manages asset class resolution via MarketSymbols and supports both proxied and
 * rate-limited (batched) request strategies.
 */
declare class ApiNasdaqQuotes {
    private readonly logger?;
    private readonly marketSymbols;
    private readonly requestProxied?;
    private readonly isInternalMarketSymbols;
    private readonly concurrencyLimit;
    /**
     * Creates an instance of ApiNasdaqQuotes.
     * @param options Configuration options for the module.
     */
    constructor(options?: ApiNasdaqQuotesOptions);
    /**
     * Retrieves real-time quotes for a batch of symbols.
     * Results are returned in an array mirroring the order of the input symbols.
     * @param symbols An array of ticker symbols (e.g. ['AAPL', 'MSFT']).
     * @returns A promise resolving to an array of NasdaqResult objects.
     */
    getNasdaqQuote<T = unknown>(symbols: string[]): Promise<NasdaqResult<T>[]>;
    /**
     * Properly shuts down internal resources and database connections.
     * Must be called if MarketSymbols was instantiated internally.
     */
    close(): Promise<void>;
}

/**
 * Result pattern for CNN API calls.
 * @template T The type of the value on success.
 */
type CnnResult<T = unknown> = {
    /** Indicates a successful request and schema validation. */
    status: "success";
    /** The filtered data from the CNN response. */
    value: T;
    /** Optional details about the response. */
    details?: unknown;
} | {
    /** Indicates a transport error or schema validation failure. */
    status: "error";
    /** The reason for the failure. */
    reason: {
        message: string;
        [key: string]: unknown;
    };
};
/**
 * Available filters for the CNN Fear & Greed API.
 * Each member corresponds to a key in the raw JSON response.
 */
declare enum CnnFearAndGreedFilter {
    /** Overall Fear & Greed Index value and description. */
    FearAndGreed = "fear_and_greed",
    /** Historical Fear & Greed Index values. */
    FearAndGreedHistorical = "fear_and_greed_historical",
    /** Market Momentum based on the S&P 500. */
    MarketMomentumSp500 = "market_momentum_sp500",
    /** Market Momentum based on the S&P 125. */
    MarketMomentumSp125 = "market_momentum_sp125",
    /** Stock Price Strength index. */
    StockPriceStrength = "stock_price_strength",
    /** Stock Price Breadth index. */
    StockPriceBreadth = "stock_price_breadth",
    /** Put and Call Options ratio. */
    PutCallOptions = "put_call_options",
    /** Market Volatility (VIX). */
    MarketVolatilityVix = "market_volatility_vix",
    /** Market Volatility (VIX 50-day moving average). */
    MarketVolatilityVix50 = "market_volatility_vix_50",
    /** Junk Bond Demand index. */
    JunkBondDemand = "junk_bond_demand",
    /** Safe Haven Demand index. */
    SafeHavenDemand = "safe_haven_demand"
}
/**
 * Input type for filtering CNN API results.
 * Can be a single filter, an array of filters, or "full" to return the entire response body.
 */
type CnnFilterInput = CnnFearAndGreedFilter | CnnFearAndGreedFilter[] | "full";
/**
 * Fetches the CNN Fear & Greed Index data.
 *
 * @param {string | "Historical"} [date] - Optional date in YYYY-MM-DD format or "Historical" for 1-year data.
 * @param {CnnFilterInput} [filter=CnnFearAndGreedFilter.FearAndGreed] - Optional filter to apply to the result.
 * @param {Options} [options={}] - Additional request options for ky.
 * @returns {Promise<CnnResult<unknown>>} A promise resolving to a CnnResult.
 */
declare function getFearAndGreed(date?: string | "Historical", filter?: CnnFilterInput, options?: Options): Promise<CnnResult<unknown>>;
/**
 * CNN Fear & Greed Index integration section.
 */
declare const CnnFearAndGreed: {
    /**
     * Fetches Fear & Greed Index data.
     */
    getFearAndGreed: typeof getFearAndGreed;
};

/**
 * Standardized options for fetching historical data.
 */
interface HistoricalOptions {
    /** Start date of the historical data range. Can be a Date object, ISO string, or Unix timestamp. */
    period1: Date | string | number;
    /** End date of the historical data range (inclusive). Defaults to current time if omitted. */
    period2?: Date | string | number;
    /** The resolution of the data points. */
    interval?: "1d" | "1wk" | "1mo";
}
/**
 * Strictly standardized JSON format for historical pricing data.
 * Dates are guaranteed to be ISO-8601 strings.
 */
interface HistoricalQuote {
    /** Trading symbol. */
    symbol: string;
    /** ISO-8601 date string for the quote. */
    date: string;
    /** Opening price. */
    open: number;
    /** Highest price during the period. */
    high: number;
    /** Lowest price during the period. */
    low: number;
    /** Closing price. */
    close: number;
    /** Trading volume. */
    volume: number;
    /** Adjusted closing price (accounting for dividends and splits). */
    adjClose: number | null;
}
/**
 * Standard Corelib result pattern for historical data.
 */
type HistoricalResult = {
    /** Indicates a successful data retrieval. */
    status: "success";
    /** Array of historical quotes. */
    value: HistoricalQuote[];
} | {
    /** Indicates a failure in data retrieval. */
    status: "error";
    /** The reason for the failure. */
    reason: {
        /** Error message. */
        message: string;
        /** Optional error payload for debugging. */
        payload?: unknown;
        [key: string]: unknown;
    };
};

/**
 * Historical Data Module
 * Provides standardized access to historical pricing data.
 */
declare const Historical: {
    /**
     * Retrieves historical data for a given symbol.
     */
    getData: (symbol: string, options: HistoricalOptions) => Promise<HistoricalResult>;
};

/**
 * NasdaqPolling handles periodic polling of Nasdaq stock quotes.
 * It uses a list of symbols and a set of proxies to fetch data via ApiNasdaqQuotes.
 * * @example
 * const poller = new NasdaqPolling(10000, ["https://proxy-url..."]);
 * poller.on("data", (data) => console.log(data));
 * poller.subscribe(["AAPL", "MSFT"]);
 * poller.start();
 */
declare class NasdaqPolling extends EventEmitter {
    private intervalId;
    private subscriptions;
    private apiInterval;
    private proxies;
    private nasdaqQuotes;
    /**
     * @param apiInterval - Polling interval in milliseconds (defaults to 10000ms/10s).
     * @param proxies - Array of proxy URLs to rotate or use for requests.
     */
    constructor(apiInterval?: number, proxies?: string[]);
    /**
     * Updates the polling interval at runtime.
     * If polling is active, it will restart with the new interval.
     * @param value - New interval in milliseconds.
     */
    setApiInterval(value: number): void;
    /**
     * Adds symbols to the internal subscription list.
     * @param symbols - Array of stock symbols (e.g., ["AAPL", "MSFT"]).
     */
    subscribe(symbols: string[]): void;
    /**
     * Removes symbols from the internal subscription list.
     * @param symbols - Array of stock symbols to remove.
     */
    unsubscribe(symbols: string[]): void;
    /**
     * Starts the polling process at the defined apiInterval.
     * If polling is already active, this method does nothing.
     */
    start(): void;
    /**
     * Stops the polling process.
     * Existing subscriptions are preserved.
     */
    stop(): void;
    /**
     * Resets the internal subscription list and halts active polling.
     */
    clear(): void;
    /**
     * Internal logic to fetch data from ApiNasdaqQuotes and emit results.
     */
    private poll;
}

/**
 * AlpacaStreaming
 * Provides a real-time data stream from Alpaca using the native Rust library via FFI.
 * Emits events for pricing, logging, and connection status.
 */
declare class AlpacaStreaming extends EventEmitter {
    private rust;
    private initialized;
    constructor();
    /**
     * Initializes the configuration for the Alpaca streaming client.
     *
     * @param {object} [config] - Configuration options.
     * @param {string} [config.dbPath] - Path to the local persistence database. Defaults to system temp.
     * @param {number} [config.silenceSeconds] - Duration of silence (in seconds) before triggering a reconnect.
     * @param {string} [config.baseUrl] - Alpaca API base URL.
     * @param {string} [config.keyId] - Alpaca API Key ID.
     * @param {string} [config.secretKey] - Alpaca API Secret Key.
     * @returns {Promise<void>}
     */
    init(config?: {
        dbPath?: string;
        silenceSeconds?: number;
        baseUrl?: string;
        keyId?: string;
        secretKey?: string;
    }): Promise<void>;
    /**
     * Starts the streaming client and begins connecting to Alpaca.
     * @returns {Promise<void>}
     */
    start(): Promise<void>;
    /**
     * Subscribes to real-time updates for the specified symbols.
     * @param {string[]} symbols - Array of trading symbols.
     */
    subscribe(symbols: string[]): void;
    /**
     * Unsubscribes from updates for the specified symbols.
     * @param {string[]} symbols - Array of trading symbols.
     */
    unsubscribe(symbols: string[]): void;
    /**
     * Cleans up the local state/database.
     */
    clean(): void;
    /**
     * Stops the streaming client and disconnects.
     */
    stop(): void;
}

/**
 * YahooStreaming
 * Provides a real-time data stream from Yahoo Finance using the native Rust library via FFI.
 * Emits events for pricing, logging, and connection status.
 */
declare class YahooStreaming extends EventEmitter {
    private rust;
    private initialized;
    constructor();
    /**
     * Initializes the configuration for the Yahoo streaming client.
     *
     * @param {object} [config] - Configuration options.
     * @param {string} [config.dbPath] - Path to the local persistence database.
     * @param {number} [config.silenceSeconds] - Duration of silence (in seconds) before triggering a reconnect.
     * @returns {Promise<void>}
     */
    init(config?: {
        dbPath?: string;
        silenceSeconds?: number;
    }): Promise<void>;
    /**
     * Starts the streaming client and begins connecting.
     * @returns {Promise<void>}
     */
    start(): Promise<void>;
    /**
     * Subscribes to real-time updates for the specified symbols.
     * @param {string[]} symbols - Array of trading symbols.
     */
    subscribe(symbols: string[]): void;
    /**
     * Unsubscribes from updates for the specified symbols.
     * @param {string[]} symbols - Array of trading symbols.
     */
    unsubscribe(symbols: string[]): void;
    /**
     * Cleans up the local state/database.
     */
    clean(): void;
    /**
     * Stops the streaming client and disconnects.
     */
    stop(): void;
}

/**
 * @module Nasdaq/Groups/Top100
 * @description Provides access to the Nasdaq 100 constituent symbols with in-memory caching and request collapsing.
 */
/**
 * Retrieves the list of Nasdaq 100 symbols, sorted alphabetically.
 *
 * @remarks
 * - If the data is already cached, it returns the cached list immediately.
 * - If a request is already in progress, it returns the existing promise.
 * - In case of failure or empty data, it logs a warning via StrictLogger and returns an empty array.
 *
 * @returns A Promise resolving to an array of ticker symbols (e.g., ["AAPL", "AMZN", ...]).
 */
declare function getSymbolsTop100(): Promise<string[]>;

/**
 * Interface matching the raw JSON data structure from Nasdaq API's "data" field.
 */
interface NasdaqMarketInfo {
    /** Country associated with the market. */
    country: string;
    /** Human-readable market status indicator (e.g., "Market Open"). */
    marketIndicator: string;
    /** UI-optimized market status indicator. */
    uiMarketIndicator: string;
    /** Human-readable countdown to market open/close (e.g., "Market Closes in 3H 37M"). */
    marketCountDown: string;
    /** Simplified market status (e.g., "Open", "Closed", "Pre Market", "After Hours"). */
    mrktStatus: string;
    /** Numeric or UI-optimized market countdown. */
    mrktCountDown: string;
    /** Pre-market opening time (e.g., "Mar 9, 2026 04:00 AM ET"). */
    preMarketOpeningTime: string;
    /** Pre-market closing time. */
    preMarketClosingTime: string;
    /** Regular market opening time. */
    marketOpeningTime: string;
    /** Regular market closing time. */
    marketClosingTime: string;
    /** After-hours market opening time. */
    afterHoursMarketOpeningTime: string;
    /** After-hours market closing time. */
    afterHoursMarketClosingTime: string;
    /** Previous trading date string (e.g., "Mar 6, 2026"). */
    previousTradeDate: string;
    /** Next trading date string (e.g., "Mar 10, 2026"). */
    nextTradeDate: string;
    /** Raw pre-market opening time in ISO format (NY time, no offset). e.g. "2026-03-09T04:00:00" */
    pmOpenRaw: string;
    /** Raw regular market opening time in ISO format. */
    openRaw: string;
    /** Raw regular market closing time in ISO format. */
    closeRaw: string;
    /** Raw after-hours market closing time in ISO format. */
    ahCloseRaw: string;
    /** Indicates if the current date is a business day for the market. */
    isBusinessDay: boolean;
}
/**
 * Calculates how long to sleep/wait based on market status in milliseconds.
 * Useful for polling services that need to wait for market open.
 *
 * @param {NasdaqMarketInfo} data - The current market information.
 * @returns {number} The sleep duration in milliseconds.
 */
declare function getSleepDuration(data: NasdaqMarketInfo): number;
/**
 * Fetches the current market status from Nasdaq API.
 * Performs strict schema validation on the response.
 *
 * @returns {Promise<NasdaqResult<NasdaqMarketInfo>>} A promise resolving to a NasdaqResult.
 */
declare function getStatus(): Promise<NasdaqResult<NasdaqMarketInfo>>;
/**
 * Market status utility.
 */
declare const MarketStatus: {
    /**
     * Fetches the current market status.
     */
    getStatus: typeof getStatus;
    /**
     * Calculates the sleep duration until next market phase.
     */
    getSleepDuration: typeof getSleepDuration;
};

/**
 * Represents the current phase of the market.
 */
type MarketPhase = "open" | "pre-market" | "after-hours" | "closed";
/**
 * MarketMonitor – resilient, adaptive market status poller.
 *
 * Long-running task that:
 * • Polls Nasdaq market status at adaptive intervals
 * • Emits phase changes immediately after first successful poll and on every phase change
 * • Falls back to heuristic (time-based) phase + cached data during fetch failures
 * • Logs warnings throttled to `warnIntervalSec`
 * • Graceful stop with 'stopped' event
 *
 * @example
 * const monitor = new MarketMonitor({ liveIntervalSec: 15 });
 * monitor.on("status-change", (phase, data, heuristic) => {
 *   console.log(`Phase changed to ${phase} (heuristic: ${!!heuristic})`, data);
 * });
 * monitor.start();
 *
 * @event status-change
 * @param {MarketPhase} phase - Current market phase
 * @param {NasdaqMarketInfo & { heuristic?: true }} data - Full market info (cloned + heuristic flag during failures)
 * @param {boolean} [heuristic] - `true` when using cached data because fetch failed
 *
 * @event stopped
 */
declare class MarketMonitor extends EventEmitter {
    private liveIntervalSec;
    private closedIntervalSec;
    private warnIntervalSec;
    private proxies;
    private proxyIndex;
    private timeoutId;
    private isRunning;
    private lastData;
    private lastPhase;
    private lastWarnTime;
    private failureCount;
    private hasEmitted;
    /**
     * @param {object} [options] - Configuration options.
     * @param {number} [options.liveIntervalSec] - Polling interval in seconds when market is active.
     * @param {number} [options.closedIntervalSec] - Polling interval in seconds when market is closed.
     * @param {number} [options.warnIntervalSec] - Interval for logging fetch failure warnings.
     * @param {string[]} [options.proxies] - Optional array of proxy URLs for status fetching.
     */
    constructor(options?: {
        liveIntervalSec?: number;
        closedIntervalSec?: number;
        warnIntervalSec?: number;
        proxies?: string[];
    });
    /** Start the monitor. First emission happens only after the first successful poll. */
    start(): void;
    /** Graceful shutdown. Clears timer and emits 'stopped'. */
    stop(): void;
    /** Current running state */
    get isRunningState(): boolean;
    /** Last known phase (real or heuristic) */
    get currentPhase(): MarketPhase;
    /** Last known full market data (null until first success) */
    get lastKnownData(): NasdaqMarketInfo | null;
    /** Number of consecutive fetch failures (reset on success) */
    get failureCountValue(): number;
    private poll;
    private handleSuccess;
    private handleFailure;
    /**
     * Determine market phase.
     * 1. Try to normalize the official mrktStatus field first
     * 2. Fall back to precise time-based calculation using the four raw timestamps
     */
    private determinePhase;
    private scheduleNextPoll;
    /**
     * Adaptive polling interval.
     * • No data yet → warnIntervalSec
     * • Has data → use liveIntervalSec or closedIntervalSec based on CURRENT (real or heuristic) phase
     */
    private getPollIntervalMs;
    private maybeLogWarn;
}

/**
 * Main entry point for market data integrations.
 * Organized by provider and data source.
 */
declare const Markets: {
    /** Nasdaq-specific integrations. */
    nasdaq: {
        /** High-performance Nasdaq API wrapper. */
        ApiNasdaqUnlimited: {
            endPoint: <T = unknown>(url: string | URL | Request, options?: ky.Options) => Promise<NasdaqResult<T>>;
            endPoints: <T = unknown>(urls: (string | URL | Request)[], options?: ky.Options) => Promise<NasdaqResult<T>[]>;
        };
        /** Simple Nasdaq quote fetcher. */
        ApiNasdaqQuotes: typeof ApiNasdaqQuotes;
        /** Persistent Nasdaq symbol database. */
        MarketSymbols: typeof MarketSymbols;
    };
};

export { AlpacaStreaming, ApiNasdaqQuotes, type ApiNasdaqQuotesOptions, ApiNasdaqUnlimited, CnnFearAndGreed, CnnFearAndGreedFilter, type CnnFilterInput, type CnnResult, Historical, type HistoricalQuote, type HistoricalResult, MarketMonitor, type MarketPhase, MarketStatus, type MarketSymbolRow, MarketSymbols, Markets, type NasdaqMarketInfo, NasdaqPolling, type NasdaqResult, YahooStreaming, getNasdaqHeaders, getSymbolsTop100 };
