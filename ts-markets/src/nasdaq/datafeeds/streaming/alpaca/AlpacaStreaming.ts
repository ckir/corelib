// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming.ts
// PURPOSE: Public TS wrapper around Rust FFI for Alpaca Streaming.
// EventEmitter with all requested methods.
// Auto-clean in development mode.
// =============================================

import { EventEmitter } from "node:events";
import { coreFFI, getMode, getTempDir } from "@ckir/corelib";

const RustAlpaca = (coreFFI as any)?.AlpacaStreaming;

/**
 * AlpacaStreaming
 * Provides a real-time data stream from Alpaca using the native Rust library via FFI.
 * Emits events for pricing, logging, and connection status.
 *
 * Construction calls into the native addon and throws SYNCHRONOUSLY if the Rust side
 * fails to initialize (e.g. redb cannot open its db path). Wrap `new AlpacaStreaming()`
 * in try/catch. Ensure ConfigManager is initialized before constructing so config-derived
 * db paths resolve.
 */
export class AlpacaStreaming extends EventEmitter {
	private rust: any;
	private initialized = false;

	constructor() {
		super();

		if (!RustAlpaca) {
			throw new Error(
				"AlpacaStreaming (Native) is not supported in this runtime (no FFI available).",
			);
		}

		try {
			this.rust = new RustAlpaca(
				(_err: any, record: any) => this.emit("log", record),
				(_err: any, data: any) => this.emit("pricing", data),
				(_err: any, event: any) => {
					if (event) {
						this.emit(event.type, event.data ?? null);
					}
				},
				(_err: any, json: string) => {
					try {
						this.emit("market", JSON.parse(json));
					} catch {}
				},
			);
		} catch (e) {
			throw new Error(
				`AlpacaStreaming: native init failed (${(e as Error).message})`,
				{ cause: e },
			);
		}

		// Auto-clean in development
		if (getMode() === "development") {
			this.rust.clean();
		}
	}

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
	async init(
		config: {
			dbPath?: string;
			silenceSeconds?: number;
			baseUrl?: string;
			keyId?: string;
			secretKey?: string;
		} = {},
	) {
		const finalConfig = {
			dbPath: config.dbPath ?? `${getTempDir()}/alpaca_streaming.redb`,
			silenceSeconds: config.silenceSeconds ?? 60,
			baseUrl: config.baseUrl ?? undefined,
			keyId: config.keyId ?? undefined,
			secretKey: config.secretKey ?? undefined,
		};
		await this.rust.init(finalConfig);
		this.initialized = true;
	}

	/**
	 * Starts the streaming client and begins connecting to Alpaca.
	 * @returns {Promise<void>}
	 */
	async start() {
		if (!this.initialized) await this.init();
		await this.rust.start();
	}

	/**
	 * Subscribes to real-time updates for the specified symbols.
	 * @param {string[] | { trades?: string[]; quotes?: string[]; bars?: string[] }} input - Array of symbols (mapped to quotes) or subscription options object.
	 */
	subscribe(
		input: string[] | { trades?: string[]; quotes?: string[]; bars?: string[] },
	) {
		const opts = Array.isArray(input) ? { quotes: input } : input;
		this.rust.subscribe(opts);
	}

	/**
	 * Unsubscribes from updates for the specified symbols.
	 * @param {string[] | { trades?: string[]; quotes?: string[]; bars?: string[] }} input - Array of symbols (mapped to quotes) or subscription options object.
	 */
	unsubscribe(
		input: string[] | { trades?: string[]; quotes?: string[]; bars?: string[] },
	) {
		const opts = Array.isArray(input) ? { quotes: input } : input;
		this.rust.unsubscribe(opts);
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
// - pricing (AlpacaPricingData)
// - log ({level, msg, extras?})
// - market (unified MarketEvent JSON, parsed object)
// - connected, disconnected, reconnecting, silence-reconnect, error
