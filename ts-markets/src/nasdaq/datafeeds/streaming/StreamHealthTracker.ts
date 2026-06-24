// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/StreamHealthTracker.ts
// PURPOSE: Bounded flight-recorder health aggregate for high-frequency streaming
// feeds. Per-tick TRACE logging would be ruinous, so a feed calls recordTick()
// (O(1)) on every tick and this emits ONE `stream: health` line every intervalMs
// carrying ticks/sec + staleness — enough for an AI to spot a frozen or slow feed
// (relative to the market phase) without per-tick volume.
// =============================================

import type { StrictLogger } from "@ckirg/corelib";

const DEFAULT_HEALTH_INTERVAL_MS = 15_000;

export class StreamHealthTracker {
	private windowTicks = 0;
	private totalTicks = 0;
	private lastTickAt = 0;
	private readonly subs = new Map<string, number>();
	private windowStart = 0;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly feed: string,
		private readonly log: StrictLogger,
		private readonly intervalMs: number = DEFAULT_HEALTH_INTERVAL_MS,
	) {}

	/** Call on every received tick. Cheap (counter + timestamp). */
	recordTick(): void {
		this.windowTicks++;
		this.totalTicks++;
		this.lastTickAt = performance.now();
	}

	/** Distinct subscribed-symbol count (refcounted across overlapping subscriptions). */
	get symbolCount(): number {
		return this.subs.size;
	}

	/** Record symbols subscribed. Refcounted so a symbol on multiple streams (quotes/trades/
	 *  bars) counts once and survives a partial unsubscribe — no undercount. */
	recordSubscribe(symbols: string[]): void {
		for (const s of symbols) this.subs.set(s, (this.subs.get(s) ?? 0) + 1);
	}

	/** Record symbols unsubscribed. Drops a symbol only when its last subscription is gone. */
	recordUnsubscribe(symbols: string[]): void {
		for (const s of symbols) {
			const n = (this.subs.get(s) ?? 0) - 1;
			if (n <= 0) this.subs.delete(s);
			else this.subs.set(s, n);
		}
	}

	/** Begin emitting periodic `stream: health`. Idempotent. */
	start(): void {
		if (this.timer) return;
		this.windowStart = performance.now();
		this.timer = setInterval(() => this.emitHealth(), this.intervalMs);
		// Never keep the process (or a test runner) alive just for the health timer.
		this.timer.unref?.();
	}

	/** Stop the periodic health emission. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private emitHealth(): void {
		const now = performance.now();
		const windowSec = (now - this.windowStart) / 1000;
		const ticksPerSec = windowSec > 0 ? this.windowTicks / windowSec : 0;
		const lastTickAgoMs =
			this.lastTickAt > 0 ? Math.round(now - this.lastTickAt) : null;
		this.log.trace("stream: health", {
			feed: this.feed,
			symbols: this.subs.size,
			ticksPerSec: Math.round(ticksPerSec * 100) / 100,
			windowTicks: this.windowTicks,
			totalTicks: this.totalTicks,
			// Raw staleness — an AI flags a frozen feed by comparing this to the
			// expected cadence for the current market phase. No hardcoded threshold.
			lastTickAgoMs,
		});
		this.windowTicks = 0;
		this.windowStart = now;
	}
}
