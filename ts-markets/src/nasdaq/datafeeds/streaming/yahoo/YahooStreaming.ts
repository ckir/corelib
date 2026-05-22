// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/yahoo/YahooStreaming.ts
// PURPOSE: Public TS wrapper around Rust FFI.
// EventEmitter with all requested methods.
// Auto-clean in development mode.
// =============================================

import { EventEmitter } from "node:events";
import { coreFFI, getMode, getTempDir } from "@ckir/corelib";

const RustYahoo = (coreFFI as any)?.YahooStreaming;

/**
 * YahooStreaming
 * Provides a real-time data stream from Yahoo Finance using the native Rust library via FFI.
 * Emits events for pricing, logging, and connection status.
 */
export class YahooStreaming extends EventEmitter {
	private rust: any;
	private initialized = false;

	constructor() {
		super();

		if (!RustYahoo) {
			throw new Error(
				"YahooStreaming (Native) is not supported in this runtime (no FFI available).",
			);
		}

		this.rust = new RustYahoo(
			(_err: any, record: any) => this.emit("log", record),
			(_err: any, data: any) => this.emit("pricing", data),
			(_err: any, event: any) => {
				if (event) {
					this.emit(event.type, event.data ?? null);
				}
			},
		);

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
		if (!this.initialized) await this.init();
		await this.rust.start();
	}

	/**
	 * Subscribes to real-time updates for the specified symbols.
	 * @param {string[]} symbols - Array of trading symbols.
	 */
	subscribe(symbols: string[]) {
		this.rust.subscribe(symbols);
	}

	/**
	 * Unsubscribes from updates for the specified symbols.
	 * @param {string[]} symbols - Array of trading symbols.
	 */
	unsubscribe(symbols: string[]) {
		this.rust.unsubscribe(symbols);
	}

	/**
	 * Cleans up the local state/database.
	 */
	clean() {
		this.rust.clean();
	}

	/**
	 * Stops the streaming client and disconnects.
	 */
	stop() {
		this.rust.stop();
	}
}

// Events emitted:
// - pricing (PricingData)
// - log ({level, msg, extras?})
// - connected, disconnected, reconnecting, silence-reconnect, error
