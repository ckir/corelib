import { EventEmitter } from "node:events";
import { logger, nextCid } from "@ckirg/corelib";
import { serializeError } from "serialize-error";
import { ApiNasdaqQuotes } from "../../../ApiNasdaqQuotes";

const nasdaqPollingLogger = logger.child({ section: "NasdaqPolling" });

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
	/** Bumped by stop() (a session boundary); a poll resumed from an older generation must not emit. */
	private generation = 0;
	/** Generation of the poll currently awaiting its quotes, or null. */
	private inFlightGeneration: number | null = null;

	/**
	 * @param apiInterval - Polling interval in milliseconds (defaults to 10000ms/10s).
	 * @param proxies - Array of proxy URLs to rotate or use for requests.
	 */
	constructor(apiInterval = 10000, proxies: string[] = []) {
		super();
		this.apiInterval = apiInterval;
		// Append "/api/v1/markets/nasdaq" to each proxy
		this.proxies = proxies.map((f) =>
			f.endsWith("/")
				? `${f}api/v1/markets/nasdaq`
				: `${f}/api/v1/markets/nasdaq`,
		);

		// Initialize ApiNasdaqQuotes with the provided proxies and global logger
		this.nasdaqQuotes = new ApiNasdaqQuotes({
			proxies: this.proxies,
			logger: nasdaqPollingLogger,
		});
	}

	/**
	 * Updates the polling interval at runtime.
	 * If polling is active, it will restart with the new interval.
	 * @param value - New interval in milliseconds.
	 */
	public setApiInterval(value: number): void {
		nasdaqPollingLogger.info(
			`Setting API interval from ${this.apiInterval}ms to ${value}ms`,
		);
		this.apiInterval = value;
		if (this.intervalId !== null) {
			// Rescheduling the timer is not a new session: keep the generation so a poll that is
			// still in flight stays valid and the restart does not fire an overlapping request.
			const generation = this.generation;
			this.stop();
			this.generation = generation;
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
		nasdaqPollingLogger.info(
			`Subscribed to ${this.subscriptions.size} symbols`,
		);
	}

	/**
	 * Removes symbols from the internal subscription list.
	 * @param symbols - Array of stock symbols to remove.
	 */
	public unsubscribe(symbols: string[]): void {
		for (const symbol of symbols) {
			this.subscriptions.delete(symbol.toUpperCase());
		}
		nasdaqPollingLogger.info(
			`Unsubscribed from ${this.subscriptions.size} symbols`,
		);
	}

	/**
	 * Starts the polling process at the defined apiInterval.
	 * If polling is already active, this method does nothing.
	 */
	public start(): void {
		if (this.intervalId !== null) {
			nasdaqPollingLogger.warn("Polling is already active.");
			return;
		}

		nasdaqPollingLogger.info(
			`Starting Nasdaq polling with interval ${this.apiInterval}ms and ${this.proxies.length} proxies.`,
		);
		this.emit("status", "started");

		// Initial poll execution
		this.runPoll();

		this.intervalId = setInterval(() => {
			this.runPoll();
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
			this.generation++; // any poll still in flight is now stale and stays silent
			nasdaqPollingLogger.info("Nasdaq polling stopped.");
			this.emit("status", "stopped");
		}
	}

	/**
	 * Resets the internal subscription list and halts active polling.
	 */
	public clear(): void {
		this.subscriptions.clear();
		nasdaqPollingLogger.info("Subscriptions cleared.");
		this.stop();
	}

	/**
	 * Runs one poll unless the previous one is still in flight (slow polls must not
	 * overlap and deliver out-of-order data). Never rejects.
	 */
	private runPoll(): void {
		const generation = this.generation;
		if (this.inFlightGeneration === generation) {
			nasdaqPollingLogger.debug("Previous poll still in flight; skipping tick");
			return;
		}
		this.inFlightGeneration = generation;
		this.poll(generation)
			.catch((error: unknown) => {
				nasdaqPollingLogger.error("Unhandled poll failure", { error });
			})
			.finally(() => {
				if (this.inFlightGeneration === generation) {
					this.inFlightGeneration = null;
				}
			});
	}

	/**
	 * Emits "error" only when someone listens (an unlistened "error" event makes
	 * EventEmitter throw). The error is always logged by the caller.
	 */
	private emitError(err: unknown): void {
		if (this.listenerCount("error") > 0) {
			this.emit("error", err);
		}
	}

	/**
	 * Internal logic to fetch data from ApiNasdaqQuotes and emit results.
	 */
	private async poll(generation: number = this.generation): Promise<void> {
		if (this.subscriptions.size === 0) {
			return;
		}

		// cid ties every line of this poll cycle together (flight-recorder).
		const cid = nextCid();
		const symbolList = Array.from(this.subscriptions);
		const startedAt = performance.now();
		nasdaqPollingLogger.trace("poll: start", {
			cid,
			requested: symbolList.length,
		});

		try {
			// Fetch quotes via ApiNasdaqQuotes
			const results = await this.nasdaqQuotes.getNasdaqQuote(symbolList);
			if (generation !== this.generation) {
				nasdaqPollingLogger.trace("poll: stale, discarded", { cid });
				return;
			}

			const validResults: unknown[] = [];

			for (const [i, result] of results.entries()) {
				nasdaqPollingLogger.trace("poll: result", {
					cid,
					symbol: symbolList[i],
					status: result.status,
				});
				if (result.status === "success" && result.value !== undefined) {
					/**
					 * Emits the "body.data" portion of the Nasdaq API response.
					 */
					this.emit("data", result.value);
					validResults.push(result.value);
				} else if (result.status === "error") {
					nasdaqPollingLogger.error("Error fetching quote", {
						cid,
						symbol: symbolList[i],
						error: serializeError(result.reason),
					});
					this.emitError(result.reason);
				}
			}

			const failed = results.length - validResults.length;
			// `missing` = symbols requested that returned no result at all — a
			// distinct signal from a returned-but-failed quote.
			const missing = symbolList.length - results.length;
			nasdaqPollingLogger.trace("poll: done", {
				cid,
				durationMs: performance.now() - startedAt,
				requested: symbolList.length,
				ok: validResults.length,
				failed,
				missing,
			});

			/**
			 * Emits the full set of successfully fetched quotes for this polling cycle.
			 */
			if (validResults.length > 0) {
				this.emit("poll-complete", validResults);
			}
		} catch (error) {
			const serialized = serializeError(error);
			nasdaqPollingLogger.trace("poll: error", {
				cid,
				durationMs: performance.now() - startedAt,
				errorMsg: error instanceof Error ? error.message : String(error),
			});
			nasdaqPollingLogger.error("Polling execution failed", {
				cid,
				error: serialized,
			});
			if (generation === this.generation) this.emitError(serialized);
		}
	}
}
