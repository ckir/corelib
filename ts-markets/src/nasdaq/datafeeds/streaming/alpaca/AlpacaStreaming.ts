// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming.ts
// PURPOSE: Public TS wrapper around Rust FFI for Alpaca Streaming.
// EventEmitter with all requested methods.
// Auto-clean in development mode.
// =============================================

import { EventEmitter } from "node:events";
import { coreFFI, getMode, getTempDir } from "@ckir/corelib";

const RustAlpaca = (coreFFI as any)?.AlpacaStreaming;

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

		this.rust = new RustAlpaca(
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
	 * Initialize configuration for Alpaca.
	 * Default DB path = system temp + alpaca_streaming.redb
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
// - pricing (AlpacaPricingData)
// - log ({level, msg, extras?})
// - connected, disconnected, reconnecting, silence-reconnect, error
