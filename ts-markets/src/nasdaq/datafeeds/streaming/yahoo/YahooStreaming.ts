/**
 * @file packages/tsdk/packages/markets/src/Nasdaq/Datafeeds/Streaming/Yahoo/YahooStreaming.ts
 * @description Yahoo Finance streaming data feed implementation using WebSocket.
 * Provides real-time ticker updates with robust reconnection logic, silence detection,
 * and database persistence. Uses Protocol Buffers for message parsing.
 *
 * FIXED (2026-03-04):
 *   • Replaced 'new Logger' with 'Logger.logger.child'
 *   • Added private isStopped flag so that stop() truly prevents reconnection
 *     (the previous close() event was triggering reconnect()).
 *   • All existing behaviour (DB persistence, metrics, silence watchdog, backoff)
 *     is preserved.
 */

import { EventEmitter } from "node:events";
import { fromBinary } from "@bufbuild/protobuf";
import { type Database, logger } from "@ckir/corelib";
import { DateTime } from "luxon";
import WebSocket from "ws";
import { PricingDataSchema } from "./generated/yaticker_pb.js";

export interface YahooStreamingOptions {
	/** Required database instance for session persistence */
	db: Database;
	/** Silence timeout before forcing reconnection (seconds, default 30) */
	silenceTimeoutSec?: number;
	/** How often to log summary metrics (seconds, default 60) */
	summaryIntervalSec?: number;
}

export class YahooStreaming extends EventEmitter {
	public static readonly WS_URL = "wss://streamer.finance.yahoo.com";

	private ws: WebSocket | null = null;
	private readonly db: Database;
	private readonly silenceTimeoutSec: number;
	private readonly summaryIntervalSec: number;

	private silenceTimer: NodeJS.Timeout | null = null;
	private summaryInterval: NodeJS.Timeout | null = null;
	private backoffMs = 1000;
	private subscriptions = new Set<string>();
	private metrics = {
		messagesReceived: 0,
		reconnects: 0,
		errors: 0,
	};

	/** Prevents reconnection after explicit stop() */
	private isStopped = false;

	private readonly logger = logger?.child({
		section: "YahooStreaming",
		source_type: "tsdk",
	});

	constructor(options: YahooStreamingOptions) {
		super();
		this.db = options.db;
		this.silenceTimeoutSec = options.silenceTimeoutSec ?? 30;
		this.summaryIntervalSec = options.summaryIntervalSec ?? 60;
	}

	public async start(subscriptions: string[]): Promise<void> {
		this.isStopped = false;
		this.subscriptions = new Set(subscriptions);

		// Create table if not exists
		await this.db.query(`
      CREATE TABLE IF NOT EXISTS yahoo_tickers (
        symbol TEXT,
        timestamp TEXT,
        price REAL,
        volume INTEGER,
        market_hours INTEGER,
        change REAL,
        change_percent REAL
      )
    `);

		await this.connect();
		this.setupSummaryLogging();
	}

	public async stop(): Promise<void> {
		this.isStopped = true;
		this.clearTimers();
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.logger?.info("Streaming stopped");
	}

	private async connect(): Promise<void> {
		if (this.isStopped) return;

		try {
			this.ws = new WebSocket(YahooStreaming.WS_URL);

			this.ws.on("open", () => {
				this.logger?.info("WebSocket connected");
				this.metrics.reconnects++;
				this.backoffMs = 1000;
				this.resetSilenceTimer();
				this.sendSubscriptions();
			});

			this.ws.on("message", (data: Buffer) => {
				this.handleMessage(data);
				this.resetSilenceTimer();
			});

			this.ws.on("error", (error: Error) => {
				this.metrics.errors++;
				this.logger?.error("WebSocket error", { error: error.message });
			});

			this.ws.on("close", () => {
				this.logger?.warn("WebSocket closed. Reconnecting...");
				this.reconnect();
			});
		} catch (error) {
			this.logger?.error("Connection failed", {
				error: (error as Error).message,
			});
			this.reconnect();
		}
	}

	private reconnect(): void {
		if (this.isStopped) return;
		this.clearTimers();
		setTimeout(() => this.connect(), this.backoffMs);
		this.backoffMs = Math.min(this.backoffMs * 2, 60000);
	}

	private sendSubscriptions(): void {
		if (this.ws?.readyState === WebSocket.OPEN && this.subscriptions.size > 0) {
			this.ws.send(
				JSON.stringify({
					subscribe: Array.from(this.subscriptions),
				}),
			);
			this.logger?.info("Subscriptions sent", {
				symbols: Array.from(this.subscriptions),
			});
		}
	}

	private async handleMessage(data: Buffer): Promise<void> {
		try {
			const message = fromBinary(PricingDataSchema, data);
			this.metrics.messagesReceived++;

			await this.db.query(
				`INSERT INTO yahoo_tickers (symbol, timestamp, price, volume, market_hours, change, change_percent) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					message.id,
					DateTime.fromMillis(Number(message.time)).toISO(),
					message.price,
					message.dayVolume,
					message.marketHours,
					message.change,
					message.changePercent,
				],
			);

			this.emit("data", message);
		} catch (error) {
			this.logger?.error("Message parsing failed", {
				error: (error as Error).message,
			});
			this.metrics.errors++;
		}
	}

	private resetSilenceTimer(): void {
		if (this.silenceTimer) clearTimeout(this.silenceTimer);
		this.silenceTimer = setTimeout(() => {
			this.logger?.warn("Silence timeout exceeded. Reconnecting...");
			if (this.ws) this.ws.close();
		}, this.silenceTimeoutSec * 1000);
	}

	private setupSummaryLogging(): void {
		if (this.summaryInterval) clearInterval(this.summaryInterval);
		this.summaryInterval = setInterval(() => {
			this.logger?.info("Metrics summary", { metrics: this.metrics });
		}, this.summaryIntervalSec * 1000);
	}

	private clearTimers(): void {
		if (this.silenceTimer) clearTimeout(this.silenceTimer);
		if (this.summaryInterval) clearInterval(this.summaryInterval);
	}
}
