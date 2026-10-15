// =============================================
// FILE: ts-markets/src/nasdaq/MarketSymbols.ts
// PURPOSE: Persistent Nasdaq symbol database (SQLite or Turso) with fallback sources.
// • Auto-creates table + indexes
// • Auto-refreshes from official Nasdaq symbol directories if empty or outdated
// • Uses MAX(ts) vs today (America/New_York) for freshness
// • Supports edge environments with optimized API/Ingestor fallback sequences
// • Open ingestor registry for extended symbol data sources
// =============================================

import {
	logger as baseLogger,
	ConfigManager,
	type Database,
	detectRuntime,
	endPoint,
	nextCid,
	sleep,
} from "@ckirg/corelib";
import { DateTime } from "luxon";
import { serializeError } from "serialize-error";
import { ApiNasdaqUnlimited } from "./ApiNasdaqUnlimited";
import { NonRealtime, Realtime } from "./AssetClass";
import { fetchSymbolFiles, type SymbolSource } from "./symbolFiles";
import { type SymbolStore, SymbolStoreUnavailableError } from "./symbolStore";
import { createSymbolStore } from "./symbolStoreFactory";

const marketSymbolsLogger = baseLogger.child({ section: "MarketSymbols" });

/** Asset classes an ingestor may legitimately return. */
const VALID_ASSET_CLASSES: ReadonlySet<string> = new Set<string>([
	...Object.values(Realtime),
	...Object.values(NonRealtime),
]);

// Primary source: anonymous FTP. The HTTPS copies sit behind a bot-challenge that answers 200 with an HTML
// page from many networks, so they are only the fallback.
const DEFAULT_NASDAQ_LISTED_URL =
	"ftp://ftp.nasdaqtrader.com/symboldirectory/nasdaqlisted.txt";
const DEFAULT_OTHER_LISTED_URL =
	"ftp://ftp.nasdaqtrader.com/symboldirectory/otherlisted.txt";
const DEFAULT_NASDAQ_LISTED_FALLBACK_URL =
	"https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt";
const DEFAULT_OTHER_LISTED_FALLBACK_URL =
	"https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt";

// The real directories hold ~11k symbols; anything far below that is an error page or a truncated file.
const DEFAULT_MIN_SYMBOL_ROWS = 1_000;

const FRESHNESS_CHECK_INTERVAL_MS = 3_600_000; // re-check staleness at most hourly on get()

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 3_600_000; // 1 hour cap per retry interval
const DEFAULT_MAX_FETCH_RETRIES = 10; // circuit breaker: give up after this many consecutive failures
const DEFAULT_STORE_BREAKER_MS = 30_000; // how long an unreachable store is skipped

/** A SymbolStore is recognised by its replaceAll method (a Database has query/transaction instead). */
function isSymbolStore(arg: unknown): arg is SymbolStore {
	return (
		typeof arg === "object" &&
		arg !== null &&
		typeof (arg as { replaceAll?: unknown }).replaceAll === "function"
	);
}

/**
 * Represents a single row in the Nasdaq symbols database.
 */
export interface MarketSymbolRow {
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
 * Interface for an external ingestor processor.
 */
interface IngestorEntry {
	pattern: RegExp;
	processor: (
		baseUrl: string,
		symbol: string,
	) => Promise<MarketSymbolRow | null>;
}

/**
 * Nasdaq symbol directory backed by a SymbolStore (SQLite or Turso today) alongside API & Ingestor fallbacks.
 *
 * Automatically refreshes on first use or when data is older than today (NY time).
 * Modifies search hierarchy (DB vs API) dynamically based on edge vs non-edge runtimes.
 */
export class MarketSymbols {
	private store: SymbolStore | null = null;
	/** True when the caller injected the store; close() then never closes it. */
	private readonly storeInjected: boolean;
	private initialized = false;
	/** In-flight initialization shared by concurrent callers; cleared on failure so the next call retries. */
	private initPromise: Promise<SymbolStore> | null = null;
	/** In-flight background refresh (at most one at a time). */
	private backgroundRefresh: Promise<void> | null = null;
	/** Last time freshness was (re)checked; drives the at-most-hourly re-check on get(). */
	private lastFreshnessCheckAt = 0;
	/** While Date.now() is below this, the store is treated as unreachable and is not called. */
	private breakerOpenUntil = 0;

	/**
	 * Registry mapping URL patterns to specific ingestor methods.
	 * Designed to be "open" for additional ingestors in future releases.
	 */
	private readonly ingestorRegistry: IngestorEntry[] = [
		{
			pattern: /script\.google\.com/i,
			processor: this.ingestorGAS.bind(this),
		},
	];

	/**
	 * @param db - Optional storage configuration or existing instance:
	 * - `undefined` → uses `${getTempDir()}/NasdaqSymbols.sqlite`
	 * - `string` → local SQLite file path
	 * - `{ dbUrl: string; dbToken: string }` → Turso/LibSQL remote
	 * - `Database` → An existing instance of a Database driver (never disconnected by close())
	 * - `SymbolStore` → An existing store (never closed by close())
	 * @param ingestors - Array of ingestor URLs (e.g., Google App Script endpoints) to query for missing symbols.
	 */
	constructor(
		private readonly db?:
			| string
			| { dbUrl: string; dbToken: string }
			| Database
			| SymbolStore,
		private readonly ingestors: string[] = [],
	) {
		this.storeInjected = isSymbolStore(db);
	}

	/**
	 * Force a full refresh of the symbol database.
	 * Called automatically on first use if needed.
	 */
	public async refresh(): Promise<void> {
		await this.ensureInitialized();
		await this.performRefresh();
	}

	/**
	 * Get symbol data.
	 * Searches Nasdaq API, external ingestors, and the DB. The sequence order is
	 * optimized dynamically based on whether it is running in an Edge environment.
	 * @returns `null` if the symbol is not found or is inactive.
	 */
	public async get(symbol: string): Promise<MarketSymbolRow | null> {
		const cid = nextCid();
		const startedAt = performance.now();
		const runtime = detectRuntime();
		const isEdge = ["cloudflare", "aws-lambda", "gcp-cloudrun"].includes(
			runtime,
		);
		marketSymbolsLogger.trace("resolve: start", { cid, symbol, isEdge });

		let result: MarketSymbolRow | null;

		if (isEdge) {
			// Edge Sequence: Nasdaq API -> Ingestors -> SQLite
			let res = await this.searchNasdaqApi(symbol);
			if (res) {
				result = res;
			} else {
				res = await this.searchIngestors(symbol);
				result = res ?? (await this.searchDb(symbol));
			}
		} else {
			// Non-Edge Sequence: SQLite -> Nasdaq API -> Ingestors
			let res = await this.searchDb(symbol);
			if (res) {
				result = res;
			} else {
				res = await this.searchNasdaqApi(symbol);
				result = res ?? (await this.searchIngestors(symbol));
			}
		}

		marketSymbolsLogger.trace("resolve: done", {
			cid,
			durationMs: performance.now() - startedAt,
			symbol,
			found: result !== null,
			assetClass: result?.class ?? null,
		});

		return result;
	}

	/**
	 * Graceful shutdown – closes the store unless it was injected by the caller.
	 */
	public async close(): Promise<void> {
		// Let an in-flight initialization settle so it does not use a nulled-out store.
		await this.initPromise?.catch(() => undefined);
		this.initPromise = null;
		if (this.store) {
			if (!this.storeInjected) {
				await this.store.close();
			}
			this.store = null;
			this.initialized = false;
		}
	}

	// -----------------------------------------------------------------------
	// Search Sequences
	// -----------------------------------------------------------------------

	/**
	 * Queries the official Nasdaq autocomplete API for a symbol.
	 * Filters for an exact match.
	 */
	private async searchNasdaqApi(
		symbol: string,
	): Promise<MarketSymbolRow | null> {
		try {
			const url = `https://api.nasdaq.com/api/autocomplete/slookup/10?search=${encodeURIComponent(symbol)}`;
			// ApiNasdaqUnlimited already extracts the .data wrapper into result.value
			const result =
				await ApiNasdaqUnlimited.endPoint<Array<Record<string, unknown>>>(url);

			if (result.status === "success" && Array.isArray(result.value)) {
				const match = result.value.find(
					(item) => String(item.symbol).toUpperCase() === symbol.toUpperCase(),
				);

				if (match) {
					const assetLower = match.asset
						? String(match.asset).toLowerCase()
						: "";
					let type: "rt" | "eod" = "eod";

					// Check if it belongs to a realtime AssetClass
					if (Object.values(Realtime).includes(assetLower as Realtime)) {
						type = "rt";
					}

					return {
						symbol: String(match.symbol),
						name: String(match.name ?? "").trim(),
						type,
						class: assetLower,
						ts: Date.now(),
						active: true,
					};
				}
			}
		} catch (e) {
			marketSymbolsLogger.warn("SearchNasdaqApi failed", {
				symbol,
				error: serializeError(e),
			});
		}
		return null;
	}

	/**
	 * Queries external ingestors defined in the constructor based on the internal registry pattern.
	 */
	private async searchIngestors(
		symbol: string,
	): Promise<MarketSymbolRow | null> {
		if (!this.ingestors || this.ingestors.length === 0) return null;

		for (const url of this.ingestors) {
			for (const entry of this.ingestorRegistry) {
				if (entry.pattern.test(url)) {
					try {
						const result = await entry.processor(url, symbol);
						if (result) return result;
					} catch (e) {
						marketSymbolsLogger.warn("Ingestor failed", {
							url,
							error: serializeError(e),
						});
					}
				}
			}
		}
		return null;
	}

	/**
	 * Specifically processes Google Apps Script (GAS) ingestor URLs.
	 */
	private async ingestorGAS(
		baseUrl: string,
		symbol: string,
	): Promise<MarketSymbolRow | null> {
		const url = new URL(baseUrl);
		url.searchParams.set("symbol", symbol);

		const result = await endPoint<Record<string, unknown>>(url.toString());

		if (result.status === "success" && result.value?.body) {
			const body = result.value.body as Record<string, unknown>;

			if (body.status === "success" && body.value) {
				const data = body.value as Record<string, unknown>;

				if (String(data.symbol).toUpperCase() === symbol.toUpperCase()) {
					const assetClass = String(data.class || "");
					if (
						assetClass !== "" &&
						!VALID_ASSET_CLASSES.has(assetClass.toLowerCase())
					) {
						marketSymbolsLogger.warn(
							"Ingestor returned an invalid asset class",
							{
								url: baseUrl,
								symbol,
							},
						);
						return null;
					}
					const rowType = data.type || "eod";
					if (rowType !== "rt" && rowType !== "eod") {
						marketSymbolsLogger.warn("Ingestor returned an invalid type", {
							url: baseUrl,
							symbol,
						});
						return null;
					}
					return {
						symbol: String(data.symbol),
						name: String(data.name || ""),
						type: rowType,
						class: assetClass,
						ts: Number(data.ts) || Date.now(),
						active: typeof data.active === "boolean" ? data.active : true,
					};
				}
			}
		}
		return null;
	}

	/**
	 * Searches the local or remote SQLite database.
	 */
	private async searchDb(symbol: string): Promise<MarketSymbolRow | null> {
		try {
			const store = await this.ensureInitialized();
			this.scheduleFreshnessCheck();
			return await this.storeCall(() => store.find(symbol));
		} catch (e) {
			marketSymbolsLogger.warn("SearchDb query failed", {
				symbol,
				error: serializeError(e),
			});
		}
		return null;
	}

	// -----------------------------------------------------------------------
	// Private Database Management
	// -----------------------------------------------------------------------

	/**
	 * Initializes the store if not already done (schema creation is the store's init()).
	 * Called automatically on first use, and before any other operations.
	 */
	private ensureInitialized(): Promise<SymbolStore> {
		if (this.isBreakerOpen()) {
			return Promise.reject(this.breakerOpenError());
		}
		if (this.store && this.initialized) return Promise.resolve(this.store);
		if (!this.initPromise) {
			const attempt = this.initialize();
			this.initPromise = attempt;
			attempt.catch(() => {
				// Clear on failure so the next call retries (only if still the current attempt).
				if (this.initPromise === attempt) this.initPromise = null;
			});
		}
		return this.initPromise;
	}

	private isBreakerOpen(): boolean {
		return Date.now() < this.breakerOpenUntil;
	}

	private breakerOpenError(): SymbolStoreUnavailableError {
		return new SymbolStoreUnavailableError(
			"Symbol store is unavailable (circuit breaker open)",
		);
	}

	/**
	 * Runs one store call behind the circuit breaker. While the breaker is open the call is not made and
	 * SymbolStoreUnavailableError is thrown at once; a SymbolStoreUnavailableError from the store opens it.
	 * Ordinary errors pass through untouched and never open it.
	 */
	private async storeCall<T>(fn: () => Promise<T>): Promise<T> {
		if (this.isBreakerOpen()) throw this.breakerOpenError();
		try {
			return await fn();
		} catch (err) {
			if (err instanceof SymbolStoreUnavailableError) {
				// Read lazily so a config change takes effect at the next outage.
				const periodMs =
					(ConfigManager.get("markets.nasdaq.symbols.breaker") as
						| number
						| undefined) ?? DEFAULT_STORE_BREAKER_MS;
				this.breakerOpenUntil = Date.now() + periodMs;
			}
			throw err;
		}
	}

	/** Builds the store from the constructor argument, else from configuration (see symbolStoreFactory). */
	private resolveStore(): SymbolStore {
		return createSymbolStore(this.db);
	}

	private async initialize(): Promise<SymbolStore> {
		const store = this.store ?? this.resolveStore();
		this.store = store;
		await this.storeCall(() => store.init());

		// Auto-refresh on first use if needed. Stale data is served immediately while the
		// refresh runs in the background; with no data at all the caller waits for the download.
		if (await this.needsRefresh()) {
			if (await this.hasExistingData()) {
				this.startBackgroundRefresh();
			} else {
				await this.performRefresh();
			}
		}

		this.initialized = true;
		this.lastFreshnessCheckAt = Date.now();
		return store;
	}

	/**
	 * Starts a non-blocking refresh. Never throws into the caller; failures are logged.
	 * Only one background refresh runs at a time.
	 */
	private startBackgroundRefresh(): void {
		if (this.backgroundRefresh) return;
		const run = this.performRefresh()
			.catch((err: unknown) => {
				marketSymbolsLogger.warn("Background symbol refresh failed", {
					error: err,
				});
			})
			.finally(() => {
				if (this.backgroundRefresh === run) this.backgroundRefresh = null;
			});
		this.backgroundRefresh = run;
	}

	/**
	 * Re-checks freshness at most once per hour so a long-running process keeps its symbols current.
	 * Fire-and-forget: never blocks or throws into the caller.
	 */
	private scheduleFreshnessCheck(): void {
		const now = Date.now();
		if (now - this.lastFreshnessCheckAt < FRESHNESS_CHECK_INTERVAL_MS) return;
		this.lastFreshnessCheckAt = now;
		void (async () => {
			try {
				if (await this.needsRefresh()) this.startBackgroundRefresh();
			} catch (err) {
				marketSymbolsLogger.warn("Symbol freshness check failed", {
					error: err,
				});
			}
		})();
	}

	/**
	 * Checks if the database needs to be refreshed.
	 * Returns true if the database has never been populated, or if the last refresh was not today.
	 * @returns {Promise<boolean>} true if the database needs to be refreshed
	 */
	private async needsRefresh(): Promise<boolean> {
		if (!this.store) return true;

		const store = this.store;
		let maxTs: number | null;
		try {
			maxTs = await this.storeCall(() => store.lastRefreshTs());
		} catch (err) {
			// An unreachable store is not a stale one: propagate so callers abort instead of downloading.
			if (err instanceof SymbolStoreUnavailableError) throw err;
			return true;
		}
		if (!maxTs) return true;

		const lastDate = DateTime.fromMillis(maxTs)
			.setZone("America/New_York")
			.startOf("day");

		const today = DateTime.now().setZone("America/New_York").startOf("day");

		return !lastDate.equals(today);
	}

	/**
	 * Refreshes the symbol database.
	 * Only runs if the database has never been populated, or if the last refresh was not today.
	 * Downloads the official Nasdaq symbol directories, parses them, and updates the database.
	 * @returns {Promise<void>} resolves after the database has been refreshed
	 */
	private async performRefresh(): Promise<void> {
		if (!(await this.needsRefresh())) return;
		const store = this.store;
		if (!store) return;

		marketSymbolsLogger.info("Starting full symbol directory refresh");

		let allRows: Map<string, MarketSymbolRow>;
		try {
			const texts = await this.fetchSymbolFilesWithRetry();
			allRows = new Map<string, MarketSymbolRow>();
			for (const r of this.parseNasdaqListed(texts.nasdaqText)) {
				allRows.set(r.symbol, r);
			}
			for (const r of this.parseOtherListed(texts.otherText)) {
				if (!allRows.has(r.symbol)) allRows.set(r.symbol, r);
			}

			// A 200 response carrying an error page or truncated file parses to few or no rows.
			// Deactivating every symbol on that would wipe the table, so refuse it before the transaction.
			const minRows =
				(ConfigManager.get("markets.nasdaq.symbols.minRows") as
					| number
					| undefined) ?? DEFAULT_MIN_SYMBOL_ROWS;
			if (allRows.size < minRows) {
				throw new Error(
					`Symbol directories parsed to ${allRows.size} rows, expected at least ${minRows}`,
				);
			}
		} catch (err) {
			// Circuit breaker fired or the download was unusable — continue with stale symbols if any
			if (await this.hasExistingData()) {
				marketSymbolsLogger.warn(
					"Symbol refresh abandoned, using existing data",
					{
						error: serializeError(err),
					},
				);
				return;
			}
			throw err;
		}

		const now = Date.now();
		const rowsArray = Array.from(allRows.values()).map((r) => ({
			...r,
			ts: now,
		}));

		await this.storeCall(() => store.replaceAll(rowsArray, now));
	}

	/**
	 * Downloads the official Nasdaq symbol directories with retry and circuit breaker.
	 * Retries with exponential backoff up to `markets.nasdaq.symbols.maxRetryBackoffMs` per interval.
	 * Stops after `markets.nasdaq.symbols.maxFetchRetries` consecutive failures even when existing data is present.
	 * Throws immediately on first failure when no existing data exists.
	 */
	private async fetchSymbolFilesWithRetry(): Promise<{
		nasdaqText: string;
		otherText: string;
	}> {
		const nasdaqListedUrl =
			(ConfigManager.get("markets.nasdaq.symbols.nasdaqListedUrl") as
				| string
				| undefined) ?? DEFAULT_NASDAQ_LISTED_URL;
		const otherListedUrl =
			(ConfigManager.get("markets.nasdaq.symbols.otherListedUrl") as
				| string
				| undefined) ?? DEFAULT_OTHER_LISTED_URL;
		const nasdaqListedFallbackUrl =
			(ConfigManager.get("markets.nasdaq.symbols.nasdaqListedFallbackUrl") as
				| string
				| undefined) ?? DEFAULT_NASDAQ_LISTED_FALLBACK_URL;
		const otherListedFallbackUrl =
			(ConfigManager.get("markets.nasdaq.symbols.otherListedFallbackUrl") as
				| string
				| undefined) ?? DEFAULT_OTHER_LISTED_FALLBACK_URL;
		const sources: SymbolSource[] = [
			{ nasdaqUrl: nasdaqListedUrl, otherUrl: otherListedUrl },
		];
		if (
			nasdaqListedFallbackUrl !== nasdaqListedUrl ||
			otherListedFallbackUrl !== otherListedUrl
		) {
			sources.push({
				nasdaqUrl: nasdaqListedFallbackUrl,
				otherUrl: otherListedFallbackUrl,
			});
		}
		const maxRetryBackoffMs =
			(ConfigManager.get("markets.nasdaq.symbols.maxRetryBackoffMs") as
				| number
				| undefined) ?? DEFAULT_MAX_RETRY_BACKOFF_MS;
		const maxFetchRetries =
			(ConfigManager.get("markets.nasdaq.symbols.maxFetchRetries") as
				| number
				| undefined) ?? DEFAULT_MAX_FETCH_RETRIES;
		let backoffMs =
			(ConfigManager.get("markets.nasdaq.symbols.initialBackoffMs") as
				| number
				| undefined) ?? DEFAULT_INITIAL_BACKOFF_MS;
		let retryCount = 0;

		while (retryCount <= maxFetchRetries) {
			try {
				const result = await fetchSymbolFiles(sources);
				if (result.status === "success") {
					return {
						nasdaqText: result.nasdaqText,
						otherText: result.otherText,
					};
				}
				const reason = result.reason;

				marketSymbolsLogger.warn("Symbol directory fetch failed – retrying", {
					retryCount,
					reason: serializeError(reason),
				});

				const hasExistingData = await this.hasExistingData();
				if (!hasExistingData) {
					throw new Error(
						`Failed to construct symbols db - ${(reason as Record<string, unknown>).message ?? JSON.stringify(serializeError(reason))}`,
					);
				}
				if (retryCount >= maxFetchRetries) {
					throw new Error(
						`Symbol fetch circuit breaker: gave up after ${maxFetchRetries} retries`,
					);
				}
				await sleep(backoffMs);
				backoffMs = Math.min(backoffMs * 2, maxRetryBackoffMs);
				retryCount++;
			} catch (err: unknown) {
				const hasExistingData = await this.hasExistingData();
				if (hasExistingData && retryCount < maxFetchRetries) {
					marketSymbolsLogger.warn("Symbol directory fetch thrown – retrying", {
						retryCount,
						error: serializeError(err),
					});
					await sleep(backoffMs);
					backoffMs = Math.min(backoffMs * 2, maxRetryBackoffMs);
					retryCount++;
					continue;
				}
				throw err;
			}
		}
		// Unreachable, but satisfies TypeScript exhaustiveness
		throw new Error(
			`Symbol fetch circuit breaker: gave up after ${maxFetchRetries} retries`,
		);
	}

	/**
	 * Checks if there is existing data in the database.
	 * Returns true if there is any existing data, false otherwise.
	 * @returns {Promise<boolean>} true if there is any existing data, false otherwise
	 */
	private async hasExistingData(): Promise<boolean> {
		if (!this.store) return false;
		const store = this.store;
		try {
			return (await this.storeCall(() => store.count())) > 0;
		} catch (err) {
			// An unreachable store is not an empty one: propagate so callers abort instead of downloading.
			if (err instanceof SymbolStoreUnavailableError) throw err;
			return false;
		}
	}

	/**
	 * Parses the official Nasdaq symbol directory file (nasdaqlisted.txt).
	 * Skips the first two lines (header) and empty lines.
	 * Skips lines with less than 8 fields (invalid).
	 * Extracts the symbol, name, and ETF status from the line.
	 * Creates a MarketSymbolRow with the extracted data and adds it to the result array.
	 * @param {string} text - The content of the nasdaqlisted.txt file as a string
	 * @returns {MarketSymbolRow[]} - An array of MarketSymbolRow objects parsed from the file
	 */
	private parseNasdaqListed(text: string): MarketSymbolRow[] {
		const rows: MarketSymbolRow[] = [];
		const lines = text.trim().split(/\r?\n/);

		for (const line of lines) {
			// The real footer is "File Creation Time: MMDDYYYYhh:mm|||||||" (colon, not pipe).
			if (
				line.startsWith("Symbol|") ||
				line.startsWith("File Creation Time") ||
				!line.trim()
			)
				continue;
			const fields = line.split("|");

			if (fields.length < 8) continue;
			const [rawSymbol, rawName, , testIssue] = fields;
			// unreachable: fields.length >= 8 was checked above
			if (
				rawSymbol === undefined ||
				rawName === undefined ||
				testIssue === undefined
			)
				continue;
			if (testIssue.trim() === "Y") continue; // test issue

			const symbol = rawSymbol.trim();
			const name = rawName.trim();
			const isEtf = fields[6] === "Y";

			rows.push({
				symbol,
				name,
				type: "rt",
				class: isEtf ? Realtime.Etf : Realtime.Stocks,
				ts: 0,
				active: true,
			});
		}
		return rows;
	}

	/**
	 * Parses the official Nasdaq symbol directory file (otherlisted.txt).
	 * Skips the first two lines (header) and empty lines.
	 * Skips lines with less than 5 fields (invalid).
	 * Extracts the symbol, name, and ETF status from the line.
	 * Creates a MarketSymbolRow with the extracted data and adds it to the result array.
	 * @param {string} text - The content of the otherlisted.txt file as a string
	 * @returns {MarketSymbolRow[]} - An array of MarketSymbolRow objects parsed from the file
	 */
	private parseOtherListed(text: string): MarketSymbolRow[] {
		const rows: MarketSymbolRow[] = [];
		const lines = text.trim().split(/\r?\n/);

		for (const line of lines) {
			// The real header starts with "ACT Symbol|" and the footer is "File Creation Time: ...|||".
			if (
				line.startsWith("Symbol|") ||
				line.startsWith("ACT Symbol|") ||
				line.startsWith("File Creation Time") ||
				!line.trim()
			)
				continue;
			const fields = line.split("|");

			if (fields.length < 5) continue;
			if (fields[6]?.trim() === "Y") continue; // test issue

			const [rawSymbol, rawName] = fields;
			// unreachable: fields.length >= 5 was checked above
			if (rawSymbol === undefined || rawName === undefined) continue;
			const symbol = rawSymbol.trim();
			const name = rawName.trim();
			const isEtf = fields[4] === "Y";

			rows.push({
				symbol,
				name,
				type: "rt",
				class: isEtf ? Realtime.Etf : Realtime.Stocks,
				ts: 0,
				active: true,
			});
		}
		return rows;
	}
}
