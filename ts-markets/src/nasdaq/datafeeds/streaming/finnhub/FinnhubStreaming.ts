// Mirrors AlpacaStreaming.ts: EventEmitter, 0-arg constructor, three ERROR-FIRST (_err, data)
// native callbacks adapted to emit("log"|"pricing"|<event.type>), config via async init().
import { EventEmitter } from "node:events";
import { coreFFI } from "@ckir/corelib";

const RustFinnhub = (coreFFI as any)?.FinnhubStreaming;

export interface FinnhubPricingData {
	symbol: string;
	message_type: string;
	price: number;
	volume: number;
	timestamp: number;
	conditions?: string[];
}
export interface FinnhubConfig {
	token?: string;
	name?: string;
}

/**
 * Real-time Finnhub trade stream via the native Rust library (coreFFI.FinnhubStreaming).
 * Emits: `pricing` (FinnhubPricingData), `log` ({level,msg,extras?}), and connection events
 * (`connected`, `disconnected`, `reconnecting`, `error`).
 */
export class FinnhubStreaming extends EventEmitter {
	private rust: any;
	private initialized = false;

	constructor() {
		super();
		if (!RustFinnhub)
			throw new Error(
				"FinnhubStreaming (Native) is not supported in this runtime (no FFI available).",
			);
		this.rust = new RustFinnhub(
			// napi invokes TSFNs error-first: (err, data). Discard err, forward data.
			(_err: any, record: any) => this.emit("log", record),
			(_err: any, data: any) => this.emit("pricing", data),
			(_err: any, event: any) => {
				if (event) this.emit(event.type, event.data ?? null);
			},
		);
	}

	async init(config: FinnhubConfig = {}): Promise<void> {
		await this.rust.init({
			token: config.token ?? undefined,
			name: config.name ?? undefined,
		});
		this.initialized = true;
	}
	async start(): Promise<void> {
		if (!this.initialized) await this.init();
		await this.rust.start();
	}
	async subscribe(symbols: string[]): Promise<void> {
		await this.rust.subscribe(symbols);
	}
	async unsubscribe(symbols: string[]): Promise<void> {
		await this.rust.unsubscribe(symbols);
	}
	async stop(): Promise<void> {
		await this.rust.stop();
	}
	async clean(): Promise<void> {
		await this.rust.clean();
	}
}
