// Mirrors AlpacaStreaming.ts: EventEmitter, 0-arg constructor, three ERROR-FIRST (_err, data)
// native callbacks adapted to emit("log"|"pricing"|<event.type>), config via async init().
import { EventEmitter } from "node:events";
import {
	coreFFI,
	type FinnhubStreamingFFI,
	logger,
	nextCid,
} from "@ckirg/corelib";
import { createNativeCallbacks } from "../nativeCallbacks.js";
import { StreamHealthTracker } from "../StreamHealthTracker.js";
import type { FinnhubPricingData } from "../types.js";

export type { FinnhubPricingData };

const RustFinnhub = coreFFI?.FinnhubStreaming;
const finnhubStreamingLogger = logger.child({ section: "FinnhubStreaming" });

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
	private rust: FinnhubStreamingFFI;
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
		const cb = createNativeCallbacks<FinnhubPricingData>(
			this,
			this.health,
			finnhubStreamingLogger,
		);
		try {
			this.rust = new RustFinnhub(
				cb.onLog,
				cb.onPricing,
				cb.onEvent,
				cb.onMarket,
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
			...(config.token != null ? { token: config.token } : {}),
			...(config.name != null ? { name: config.name } : {}),
			...(config.baseUrl != null ? { baseUrl: config.baseUrl } : {}),
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
		await this.rust.subscribe(symbols);
		this.health.recordSubscribe(symbols);
		finnhubStreamingLogger.trace("stream: subscribe", {
			feed: "finnhub",
			symbols: this.health.symbolCount,
		});
	}
	async unsubscribe(symbols: string[]): Promise<void> {
		await this.rust.unsubscribe(symbols);
		this.health.recordUnsubscribe(symbols);
		finnhubStreamingLogger.trace("stream: unsubscribe", {
			feed: "finnhub",
			symbols: this.health.symbolCount,
		});
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
