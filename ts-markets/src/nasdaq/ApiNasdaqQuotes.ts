import {
	ConfigManager,
	logger,
	nextCid,
	RequestProxied,
	type StrictLogger,
} from "@ckirg/corelib";
import { ApiNasdaqUnlimited, type NasdaqResult } from "./ApiNasdaqUnlimited";
import { MarketSymbols } from "./MarketSymbols";

const apiNasdaqQuotesLogger = logger.child({ section: "ApiNasdaqQuotes" });

const DEFAULT_CONCURRENCY_LIMIT = 5;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Results are written by the
 * callback itself (via the index), so output order never depends on completion order.
 */
async function mapWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
	const queue = items.entries();
	const worker = async () => {
		for (const [i, item] of queue) {
			await fn(item, i);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
}

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
	private readonly logger: StrictLogger;
	private readonly marketSymbols: MarketSymbols;
	private readonly requestProxied?: RequestProxied;
	private readonly isInternalMarketSymbols: boolean;
	private readonly concurrencyLimit: number;

	/**
	 * Creates an instance of ApiNasdaqQuotes.
	 * @param options Configuration options for the module.
	 */
	constructor(options: ApiNasdaqQuotesOptions = {}) {
		this.logger = options.logger
			? options.logger.child({ section: "ApiNasdaqQuotes" })
			: apiNasdaqQuotesLogger;
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
		const cid = nextCid();
		const startedAt = performance.now();
		const batches = this.requestProxied
			? 1
			: Math.ceil(symbols.length / this.concurrencyLimit);
		this.logger.trace("getNasdaqQuote: start", {
			cid,
			requested: symbols.length,
			batches,
			concurrency: this.concurrencyLimit,
		});

		const results: NasdaqResult<T>[] = new Array(symbols.length);
		const fetchQueue: { symbol: string; url: string; index: number }[] = [];

		// 1. Resolve Asset Classes (bounded concurrency; order is preserved via the index)
		const resolved = new Array<{ symbol: string; url: string } | undefined>(
			symbols.length,
		);
		await mapWithConcurrency(
			symbols,
			Math.max(1, this.concurrencyLimit),
			async (raw, i) => {
				const symbol = raw.toUpperCase();
				try {
					const symbolData = await this.marketSymbols.get(symbol);
					if (!symbolData) {
						results[i] = {
							status: "error",
							reason: {
								message: `Symbol ${symbol} not found in MarketSymbols`,
							},
						};
						return;
					}

					const assetClass = symbolData.class || "stocks";
					const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${encodeURIComponent(assetClass.toLowerCase())}`;
					resolved[i] = { symbol, url };
				} catch (error: unknown) {
					const message =
						error instanceof Error ? error.message : String(error);
					this.logger.warn("Error resolving asset class", {
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
			},
		);
		for (let i = 0; i < resolved.length; i++) {
			const r = resolved[i];
			if (r) fetchQueue.push({ symbol: r.symbol, url: r.url, index: i });
		}

		if (fetchQueue.length === 0) return results;

		// 2. Execute requests using the appropriate strategy
		if (this.requestProxied) {
			// RequestProxied.endPoints takes an array of URLs and load-balances them
			const urls = fetchQueue.map((q) => q.url);
			const proxyResults = await this.requestProxied.endPoints<T>(urls);

			for (const [i, pRes] of proxyResults.entries()) {
				const q = fetchQueue[i];
				if (q === undefined) continue; // unreachable: one URL per queue entry

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

		const ok = results.filter((r) => r?.status === "success").length;
		const failed = results.filter((r) => r?.status === "error").length;
		this.logger.trace("getNasdaqQuote: done", {
			cid,
			durationMs: performance.now() - startedAt,
			requested: symbols.length,
			ok,
			failed,
			sampleSymbol: symbols[0],
		});

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
