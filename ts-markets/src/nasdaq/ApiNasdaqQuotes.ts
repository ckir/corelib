import {
	ConfigManager,
	RequestProxied,
	type StrictLogger,
} from "@ckir/corelib";
import { ApiNasdaqUnlimited, type NasdaqResult } from "./ApiNasdaqUnlimited";
import { MarketSymbols } from "./MarketSymbols";

const DEFAULT_CONCURRENCY_LIMIT = 5;

/**
 * Configuration options for the ApiNasdaqQuotes module.
 */
export interface ApiNasdaqQuotesOptions {
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
export class ApiNasdaqQuotes {
	private readonly logger?: StrictLogger;
	private readonly marketSymbols: MarketSymbols;
	private readonly requestProxied?: RequestProxied;
	private readonly isInternalMarketSymbols: boolean;
	private readonly concurrencyLimit: number;

	/**
	 * Creates an instance of ApiNasdaqQuotes.
	 * @param options Configuration options for the module.
	 */
	constructor(options: ApiNasdaqQuotesOptions = {}) {
		const baseLogger = options.logger || (globalThis as any).logger;
		this.logger = baseLogger?.child({ section: "ApiNasdaqQuotes" });
		this.concurrencyLimit =
			options.concurrencyLimit ??
			(ConfigManager.get("markets.nasdaq.quotes.concurrencyLimit") as
				| number
				| undefined) ??
			DEFAULT_CONCURRENCY_LIMIT;

		if (options.marketSymbols) {
			this.marketSymbols = options.marketSymbols;
			this.isInternalMarketSymbols = false;
		} else {
			this.marketSymbols = new MarketSymbols();
			this.isInternalMarketSymbols = true;
		}

		if (options.proxies && options.proxies.length > 0) {
			this.requestProxied = new RequestProxied(options.proxies);
		}
	}

	/**
	 * Retrieves real-time quotes for a batch of symbols.
	 * Results are returned in an array mirroring the order of the input symbols.
	 * @param symbols An array of ticker symbols (e.g. ['AAPL', 'MSFT']).
	 * @returns A promise resolving to an array of NasdaqResult objects.
	 */
	public async getNasdaqQuote<T = unknown>(
		symbols: string[],
	): Promise<NasdaqResult<T>[]> {
		const results: NasdaqResult<T>[] = new Array(symbols.length);
		const fetchQueue: { symbol: string; url: string; index: number }[] = [];

		// 1. Resolve Asset Classes and prepare the fetch queue
		for (let i = 0; i < symbols.length; i++) {
			const symbol = symbols[i].toUpperCase();
			try {
				const symbolData = await this.marketSymbols.get(symbol);
				if (!symbolData) {
					results[i] = {
						status: "error",
						reason: { message: `Symbol ${symbol} not found in MarketSymbols` },
					};
					continue;
				}

				const assetClass = symbolData.class || "stocks";
				const url = `https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=${assetClass.toLowerCase()}`;
				fetchQueue.push({ symbol, url, index: i });
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger?.warn("Error resolving asset class", {
					symbol,
					error: message,
				});
				results[i] = {
					status: "error",
					reason: {
						message: `Internal error during symbol resolution: ${message}`,
					},
				};
			}
		}

		if (fetchQueue.length === 0) return results;

		// 2. Execute requests using the appropriate strategy
		if (this.requestProxied) {
			// RequestProxied.endPoints takes an array of URLs and load-balances them
			const urls = fetchQueue.map((q) => q.url);
			const proxyResults = await this.requestProxied.endPoints<T>(urls);

			for (let i = 0; i < proxyResults.length; i++) {
				const q = fetchQueue[i];
				const pRes = proxyResults[i];

				if (pRes.status === "success") {
					// We need to verify if the Nasdaq API returned an error in the body
					const body = pRes.value.body as Record<string, unknown>;
					const statusObj = body?.status as Record<string, unknown> | undefined;
					if (statusObj?.rCode === 200) {
						results[q.index] = {
							status: "success",
							value: body.data as T,
							details: pRes.value,
						};
					} else {
						const devMsg =
							typeof statusObj?.developerMessage === "string"
								? statusObj.developerMessage
								: "Nasdaq API Error via Proxy";
						results[q.index] = {
							status: "error",
							reason: { message: devMsg },
						};
					}
				} else {
					const errMsg = (pRes.reason as Record<string, unknown>)?.message;
					results[q.index] = {
						status: "error",
						reason: {
							message:
								typeof errMsg === "string" ? errMsg : "Proxy request failed",
						},
					};
				}
			}
		} else {
			// Non-proxied: Use ApiNasdaqUnlimited with concurrency limiting
			for (let i = 0; i < fetchQueue.length; i += this.concurrencyLimit) {
				const batch = fetchQueue.slice(i, i + this.concurrencyLimit);
				const batchTasks = batch.map(async (q) => {
					try {
						const res = await ApiNasdaqUnlimited.endPoint<T>(q.url);
						results[q.index] = res;
					} catch (error: unknown) {
						results[q.index] = {
							status: "error",
							reason: {
								message:
									error instanceof Error
										? error.message
										: "Unlimited fetch failed",
							},
						};
					}
				});
				await Promise.all(batchTasks);
			}
		}

		return results;
	}

	/**
	 * Properly shuts down internal resources and database connections.
	 * Must be called if MarketSymbols was instantiated internally.
	 */
	public async close(): Promise<void> {
		if (this.isInternalMarketSymbols) {
			await this.marketSymbols.close();
		}
	}
}
