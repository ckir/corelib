import { EventEmitter } from "node:events";
import { logger } from "@ckir/corelib";
import { serializeError } from "serialize-error";
import { ApiNasdaqQuotes } from "../../../ApiNasdaqQuotes";

/**
 * NasdaqPolling handles periodic polling of Nasdaq stock quotes.
 * It uses a list of symbols and a set of proxies to fetch data via ApiNasdaqQuotes.
 * * @example
 * const poller = new NasdaqPolling(10000, ["https://proxy-url..."]);
 * poller.on("data", (data) => console.log(data));
 * poller.subscribe(["AAPL", "MSFT"]);
 * poller.start();
 */
export class NasdaqPolling extends EventEmitter {
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private subscriptions: Set<string> = new Set();
	private apiInterval: number;
	private proxies: string[];
	private nasdaqQuotes: ApiNasdaqQuotes;

	/**
	 * @param apiInterval - Polling interval in milliseconds (defaults to 10000ms/10s).
	 * @param proxies - Array of proxy URLs to rotate or use for requests.
	 */
	constructor(apiInterval = 10000, proxies: string[] = []) {
		super();
		this.apiInterval = apiInterval;
		this.proxies = proxies;

		// Initialize ApiNasdaqQuotes with the provided proxies and global logger
		this.nasdaqQuotes = new ApiNasdaqQuotes({
			proxies: this.proxies,
			logger: logger,
		});
	}

	/**
	 * Updates the polling interval at runtime.
	 * If polling is active, it will restart with the new interval.
	 * @param value - New interval in milliseconds.
	 */
	public setApiInterval(value: number): void {
		logger.info("[NasdaqPolling] Setting API interval", {
			old: this.apiInterval,
			new: value,
		});
		this.apiInterval = value;
		if (this.intervalId !== null) {
			this.stop();
			this.start();
		}
	}

	/**
	 * Adds symbols to the internal subscription list.
	 * @param symbols - Array of stock symbols (e.g., ["AAPL", "MSFT"]).
	 */
	public subscribe(symbols: string[]): void {
		for (const symbol of symbols) {
			this.subscriptions.add(symbol.toUpperCase());
		}
		logger.info("[NasdaqPolling] Subscribed to symbols", {
			currentCount: this.subscriptions.size,
		});
	}

	/**
	 * Removes symbols from the internal subscription list.
	 * @param symbols - Array of stock symbols to remove.
	 */
	public unsubscribe(symbols: string[]): void {
		for (const symbol of symbols) {
			this.subscriptions.delete(symbol.toUpperCase());
		}
		logger.info("[NasdaqPolling] Unsubscribed from symbols", {
			currentCount: this.subscriptions.size,
		});
	}

	/**
	 * Starts the polling process at the defined apiInterval.
	 * If polling is already active, this method does nothing.
	 */
	public start(): void {
		if (this.intervalId !== null) {
			logger.warn("[NasdaqPolling] Polling is already active.");
			return;
		}

		logger.info("[NasdaqPolling] Starting Nasdaq polling", {
			interval: this.apiInterval,
		});
		this.emit("status", "started");

		// Initial poll execution
		void this.poll();

		this.intervalId = setInterval(() => {
			void this.poll();
		}, this.apiInterval);
	}

	/**
	 * Stops the polling process.
	 * Existing subscriptions are preserved.
	 */
	public stop(): void {
		if (this.intervalId !== null) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			logger.info("[NasdaqPolling] Nasdaq polling stopped.");
			this.emit("status", "stopped");
		}
	}

	/**
	 * Resets the internal subscription list and halts active polling.
	 */
	public clear(): void {
		this.subscriptions.clear();
		logger.info("[NasdaqPolling] Subscriptions cleared.");
		this.stop();
	}

	/**
	 * Internal logic to fetch data from ApiNasdaqQuotes and emit results.
	 */
	private async poll(): Promise<void> {
		if (this.subscriptions.size === 0) {
			return;
		}

		const symbolList = Array.from(this.subscriptions);

		try {
			// Fetch quotes via ApiNasdaqQuotes
			const results = await this.nasdaqQuotes.getNasdaqQuote(symbolList);

			for (const result of results) {
				if (result.status === "success" && result.value !== undefined) {
					/**
					 * Emits the "body.data" portion of the Nasdaq API response.
					 */
					this.emit("data", result.value);
				} else if (result.status === "error") {
					logger.error("[NasdaqPolling] Error fetching quote", {
						error: result.reason,
					});
					this.emit("error", result.reason);
				}
			}
		} catch (error) {
			const serialized = serializeError(error);
			logger.error("[NasdaqPolling] Polling execution failed", {
				error: serialized,
			});
			this.emit("error", serialized);
		}
	}
}
