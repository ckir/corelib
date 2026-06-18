// Mirrors AlpacaStreaming.ts: EventEmitter, 0-arg constructor, three ERROR-FIRST (_err, data)
// native callbacks adapted to emit("log"|"pricing"|<event.type>), config via async init().
import { EventEmitter } from "node:events";
import { coreFFI, logger, nextCid } from "@ckir/corelib";
import { StreamHealthTracker } from "../StreamHealthTracker.js";

const RustFinnhub = (coreFFI as any)?.FinnhubStreaming;
const finnhubStreamingLogger = logger.child({ section: "FinnhubStreaming" });

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
	baseUrl?: string;
}

/**
 * Real-time Finnhub trade stream via the native Rust library (coreFFI.FinnhubStreaming).
 * Emits: `pricing` (FinnhubPricingData), `log` ({level,msg,extras?}), and connection events
 * (`connected`, `disconnected`, `reconnecting`, `error`).
 *
 * Construction calls into the native addon and throws SYNCHRONOUSLY if the Rust side
 * fails to initialize (e.g. redb cannot open its db path). Wrap `new FinnhubStreaming()`
 * in try/catch. Ensure ConfigManager is initialized before constructing so config-derived
 * db paths resolve.
 */
export class FinnhubStreaming extends EventEmitter {
	private rust: any;
	private initialized = false;
	private readonly health = new StreamHealthTracker(
		"finnhub",
		finnhubStreamingLogger,
	);

	constructor() {
		super();
		if (!RustFinnhub)
			throw new Error(
				"FinnhubStreaming (Native) is not supported in this runtime (no FFI available).",
			);
		try {
			this.rust = new RustFinnhub(
				// napi invokes TSFNs error-first: (err, data). Discard err, forward data.
				(_err: any, record: any) => this.emit("log", record),
				(_err: any, data: any) => {
					this.health.recordTick();
					this.emit("pricing", data);
				},
				(_err: any, event: any) => {
					if (event) this.emit(event.type, event.data ?? null);
				},
				(_err: any, json: string) => {
					try {
						this.emit("market", JSON.parse(json));
					} catch {}
				},
			);
		} catch (e) {
			throw new Error(
				`FinnhubStreaming: native init failed (${(e as Error).message})`,
				{ cause: e },
			);
		}
	}

	async init(config: FinnhubConfig = {}): Promise<void> {
		await this.rust.init({
			token: config.token ?? undefined,
			name: config.name ?? undefined,
			base_url: config.baseUrl ?? undefined,
		});
		this.initialized = true;
	}
	async start(): Promise<void> {
		const cid = nextCid();
		finnhubStreamingLogger.trace("stream: start", {
			cid,
			feed: "finnhub",
			symbols: this.health.symbolCount,
		});
		if (!this.initialized) await this.init();
		await this.rust.start();
		this.health.start();
	}
	async subscribe(symbols: string[]): Promise<void> {
		this.health.recordSubscribe(symbols);
		finnhubStreamingLogger.trace("stream: subscribe", {
			feed: "finnhub",
			symbols: this.health.symbolCount,
		});
		await this.rust.subscribe(symbols);
	}
	async unsubscribe(symbols: string[]): Promise<void> {
		this.health.recordUnsubscribe(symbols);
		finnhubStreamingLogger.trace("stream: unsubscribe", {
			feed: "finnhub",
			symbols: this.health.symbolCount,
		});
		await this.rust.unsubscribe(symbols);
	}
	async stop(): Promise<void> {
		finnhubStreamingLogger.trace("stream: stop", { feed: "finnhub" });
		this.health.stop();
		await this.rust.stop();
	}
	async clean(): Promise<void> {
		await this.rust.clean();
	}
}
