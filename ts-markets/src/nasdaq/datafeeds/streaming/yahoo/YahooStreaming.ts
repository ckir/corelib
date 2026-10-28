// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/yahoo/YahooStreaming.ts
// PURPOSE: Public TS wrapper around Rust FFI.
// EventEmitter with all requested methods.
// Auto-clean in development mode.
// =============================================

import { EventEmitter } from "node:events";
import {
	coreFFI,
	getMode,
	getTempDir,
	logger,
	nextCid,
	type YahooStreamingFFI,
} from "@ckirg/corelib";
import {
	afterNativeSuccess,
	createNativeCallbacks,
} from "../nativeCallbacks.js";
import { ProcessKeepAlive } from "../ProcessKeepAlive.js";
import { StreamHealthTracker } from "../StreamHealthTracker.js";
import type { YahooPricingData } from "../types.js";

const RustYahoo = coreFFI?.YahooStreaming;
const yahooStreamingLogger = logger.child({ section: "YahooStreaming" });

/**
 * YahooStreaming
 * Provides a real-time data stream from Yahoo Finance using the native Rust library via FFI.
 * Emits events for pricing, logging, and connection status.
 *
 * Construction calls into the native addon and throws SYNCHRONOUSLY if the Rust side
 * fails to initialize (e.g. redb cannot open its db path). Wrap `new YahooStreaming()`
 * in try/catch. Ensure ConfigManager is initialized before constructing so config-derived
 * db paths resolve.
 */
export class YahooStreaming extends EventEmitter {
	private rust: YahooStreamingFFI;
	private initialized = false;
	private readonly keepAlive = new ProcessKeepAlive();
	private readonly health = new StreamHealthTracker(
		"yahoo",
		yahooStreamingLogger,
	);

	constructor() {
		super();

		if (!RustYahoo) {
			throw new Error(
				"YahooStreaming (Native) is not supported in this runtime (no FFI available).",
			);
		}

		const cb = createNativeCallbacks<YahooPricingData>(
			this,
			this.health,
			yahooStreamingLogger,
		);
		try {
			this.rust = new RustYahoo(
				cb.onLog,
				cb.onPricing,
				cb.onEvent,
				cb.onMarket,
			);
		} catch (e) {
			throw new Error(
				`YahooStreaming: native init failed (${(e as Error).message})`,
				{ cause: e },
			);
		}

		// Auto-clean in development
		if (getMode() === "development") {
			this.rust.clean();
		}
	}

	/**
	 * Initializes the configuration for the Yahoo streaming client.
	 *
	 * @param {object} [config] - Configuration options.
	 * @param {string} [config.dbPath] - Path to the local persistence database.
	 * @param {number} [config.silenceSeconds] - Duration of silence (in seconds) before triggering a reconnect.
	 * @returns {Promise<void>}
	 */
	async init(config: { dbPath?: string; silenceSeconds?: number } = {}) {
		const finalConfig = {
			dbPath: config.dbPath ?? `${getTempDir()}/yahoo_streaming.redb`,
			silenceSeconds: config.silenceSeconds ?? 60,
		};
		await this.rust.init(finalConfig);
		this.initialized = true;
	}

	/**
	 * Starts the streaming client and begins connecting.
	 * @returns {Promise<void>}
	 */
	async start() {
		const cid = nextCid();
		yahooStreamingLogger.trace("stream: start", {
			cid,
			feed: "yahoo",
			symbols: this.health.symbolCount,
		});
		if (!this.initialized) await this.init();
		await this.rust.start();
		this.health.start();
		this.keepAlive.hold();
	}

	/**
	 * Subscribes to real-time updates for the specified symbols.
	 * @param {string[]} symbols - Array of trading symbols.
	 */
	subscribe(symbols: string[]) {
		afterNativeSuccess(
			this.rust.subscribe(symbols),
			() => {
				this.health.recordSubscribe(symbols);
				yahooStreamingLogger.trace("stream: subscribe", {
					feed: "yahoo",
					symbols: this.health.symbolCount,
				});
			},
			yahooStreamingLogger,
			"subscribe",
		);
	}

	/**
	 * Unsubscribes from updates for the specified symbols.
	 * @param {string[]} symbols - Array of trading symbols.
	 */
	unsubscribe(symbols: string[]) {
		afterNativeSuccess(
			this.rust.unsubscribe(symbols),
			() => {
				this.health.recordUnsubscribe(symbols);
				yahooStreamingLogger.trace("stream: unsubscribe", {
					feed: "yahoo",
					symbols: this.health.symbolCount,
				});
			},
			yahooStreamingLogger,
			"unsubscribe",
		);
	}

	/**
	 * Cleans up the local state/database.
	 */
	clean() {
		this.health.stop();
		this.keepAlive.release();
		this.rust.clean();
	}

	/**
	 * Stops the streaming client and disconnects.
	 */
	stop() {
		yahooStreamingLogger.trace("stream: stop", { feed: "yahoo" });
		this.health.stop();
		this.keepAlive.release();
		this.rust.stop();
	}
}

// Events emitted:
// - pricing (YahooPricingData)
// - log ({level, msg, extras?})
// - market (unified MarketEvent JSON, parsed object)
// - connected, disconnected, reconnecting, error
