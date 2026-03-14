// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/yahoo/YahooStreaming.ts
// PURPOSE: Public TS wrapper around Rust FFI.
// EventEmitter with all requested methods.
// Auto-clean in development mode.
// =============================================

import { EventEmitter } from "node:events";
import { coreFFI, getMode, getTempDir } from "@ckir/corelib";

const { YahooStreaming: RustYahoo } = coreFFI as any; // napi class

export class YahooStreaming extends EventEmitter {
	private rust: InstanceType<typeof RustYahoo>;
	private initialized = false;

	constructor() {
		super();

		this.rust = new RustYahoo(
			(_err, record) => this.emit("log", record),
			(_err, data) => this.emit("pricing", data),
			(_err, event) => {
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
	 * Initialize configuration.
	 * Default DB path = system temp + yahoo_streaming.redb
	 */
	async init(config: { dbPath?: string; silenceSeconds?: number } = {}) {
		const finalConfig = {
			dbPath: config.dbPath ?? `${getTempDir()}/yahoo_streaming.redb`,
			silenceSeconds: config.silenceSeconds ?? 60,
		};
		await this.rust.init(finalConfig);
		this.initialized = true;
	}

	async start() {
		if (!this.initialized) await this.init();
		await this.rust.start();
	}

	subscribe(symbols: string[]) {
		this.rust.subscribe(symbols);
	}

	unsubscribe(symbols: string[]) {
		this.rust.unsubscribe(symbols);
	}

	clean() {
		this.rust.clean();
	}

	stop() {
		this.rust.stop();
	}
}

// Events emitted:
// - pricing (PricingData)
// - log ({level, msg, extras?})
// - connected, disconnected, reconnecting, silence-reconnect, error
