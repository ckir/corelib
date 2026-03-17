// =============================================
// FILE: ts-markets\src\nasdaq\MarketMonitor.ts
// PURPOSE: Long-running resilient market status poller.
// Uses MarketStatus.getStatus() with fallback heuristic calculation.
// Emits only after the first successful poll and on phase changes.
// Fully resilient: continues with cached data + time-based phase during failures.
// Polling interval adapts to current phase (live/closed) or warnInterval during failure.
// Fully documented, lint-clean, uses StrictLogger.
// =============================================

import { EventEmitter } from "node:events";
import { logger } from "@ckir/corelib";
import { DateTime } from "luxon";
import { MarketStatus, type NasdaqMarketInfo } from "./MarketStatus";

export type MarketPhase = "open" | "pre-market" | "after-hours" | "closed";

/**
 * MarketMonitor – resilient, adaptive market status poller.
 *
 * Long-running task that:
 * • Polls Nasdaq market status at adaptive intervals
 * • Emits phase changes immediately after first successful poll and on every phase change
 * • Falls back to heuristic (time-based) phase + cached data during fetch failures
 * • Logs warnings throttled to `warnIntervalSec`
 * • Graceful stop with 'stopped' event
 *
 * @example
 * const monitor = new MarketMonitor({ liveIntervalSec: 15 });
 * monitor.on("status-change", (phase, data, heuristic) => {
 *   console.log(`Phase changed to ${phase} (heuristic: ${!!heuristic})`, data);
 * });
 * monitor.start();
 *
 * @event status-change
 * @param {MarketPhase} phase - Current market phase
 * @param {NasdaqMarketInfo & { heuristic?: true }} data - Full market info (cloned + heuristic flag during failures)
 * @param {boolean} [heuristic] - `true` when using cached data because fetch failed
 *
 * @event stopped
 */
export class MarketMonitor extends EventEmitter {
	private liveIntervalSec: number;
	private closedIntervalSec: number;
	private warnIntervalSec: number;

	private timeoutId: NodeJS.Timeout | null = null;
	private isRunning = false;
	private lastData: NasdaqMarketInfo | null = null;
	private lastPhase: MarketPhase = "closed";
	private lastWarnTime = 0;
	private failureCount = 0;
	private hasEmitted = false;

	constructor(
		options: {
			liveIntervalSec?: number;
			closedIntervalSec?: number;
			warnIntervalSec?: number;
		} = {},
	) {
		super();
		this.liveIntervalSec = options.liveIntervalSec ?? 10;
		this.closedIntervalSec = options.closedIntervalSec ?? 3600;
		this.warnIntervalSec = options.warnIntervalSec ?? 60;
	}

	/** Start the monitor. First emission happens only after the first successful poll. */
	start(): void {
		if (this.isRunning) return;
		this.isRunning = true;
		this.failureCount = 0;
		logger.info("[MarketMonitor] Starting market status monitor");
		this.poll(); // kick off the first poll immediately
	}

	/** Graceful shutdown. Clears timer and emits 'stopped'. */
	stop(): void {
		if (!this.isRunning) return;
		this.isRunning = false;
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = null;
		}
		logger.info("[MarketMonitor] Monitor stopped");
		this.emit("stopped");
	}

	/** Current running state */
	get isRunningState(): boolean {
		return this.isRunning;
	}

	/** Last known phase (real or heuristic) */
	get currentPhase(): MarketPhase {
		return this.lastPhase;
	}

	/** Last known full market data (null until first success) */
	get lastKnownData(): NasdaqMarketInfo | null {
		return this.lastData ? { ...this.lastData } : null;
	}

	/** Number of consecutive fetch failures (reset on success) */
	get failureCountValue(): number {
		return this.failureCount;
	}

	private async poll(): Promise<void> {
		if (!this.isRunning) return;

		try {
			const result = await MarketStatus.getStatus();

			if (result.status === "success") {
				this.handleSuccess(result.value);
			} else {
				this.handleFailure();
			}
		} catch (err) {
			logger.error("[MarketMonitor] Unexpected poll error", { error: err });
			this.handleFailure();
		}

		this.scheduleNextPoll();
	}

	private handleSuccess(data: NasdaqMarketInfo): void {
		this.failureCount = 0;
		this.lastData = { ...data }; // keep a clean clone

		const phase = this.determinePhase(data);
		const phaseChanged = phase !== this.lastPhase;

		this.lastPhase = phase;

		// Emit only after first successful poll AND on every subsequent phase change
		if (!this.hasEmitted || phaseChanged) {
			this.emit("status-change", phase, { ...data }, false);
			this.hasEmitted = true;
		}
	}

	private handleFailure(): void {
		this.failureCount++;

		if (!this.lastData) {
			this.maybeLogWarn();
			return; // no data yet → nothing to emit
		}

		// Heuristic: compute phase from cached data + CURRENT time
		// We explicitly clear mrktStatus to force time-based calculation
		const phase = this.determinePhase({ ...this.lastData, mrktStatus: "" });
		const phaseChanged = phase !== this.lastPhase;

		this.lastPhase = phase;

		// Clone + mark as heuristic
		const heuristicData: NasdaqMarketInfo & { heuristic: true } = {
			...this.lastData,
			mrktStatus: "", // Official status is no longer valid during heuristic calculation
			heuristic: true,
		};

		if (phaseChanged) {
			this.emit("status-change", phase, heuristicData, true);
		}

		this.maybeLogWarn();
	}

	/**
	 * Determine market phase.
	 * 1. Try to normalize the official mrktStatus field first
	 * 2. Fall back to precise time-based calculation using the four raw timestamps
	 */
	private determinePhase(data: NasdaqMarketInfo): MarketPhase {
		const rawStatus = (data.mrktStatus || "").toLowerCase().trim();

		// Direct mapping from official API status (preferred)
		if (
			rawStatus.includes("open") &&
			!rawStatus.includes("after") &&
			!rawStatus.includes("pre")
		) {
			return "open";
		}
		if (rawStatus.includes("pre") || rawStatus.includes("pre-market")) {
			return "pre-market";
		}
		if (rawStatus.includes("after") || rawStatus.includes("after-hours")) {
			return "after-hours";
		}
		if (rawStatus.includes("closed")) {
			return "closed";
		}

		// Time-based fallback (used when mrktStatus is missing or heuristic)
		const now = DateTime.now().setZone("America/New_York");
		const pmOpen = DateTime.fromISO(data.pmOpenRaw || "", {
			zone: "America/New_York",
		});
		const mOpen = DateTime.fromISO(data.openRaw || "", {
			zone: "America/New_York",
		});
		const mClose = DateTime.fromISO(data.closeRaw || "", {
			zone: "America/New_York",
		});
		const ahClose = DateTime.fromISO(data.ahCloseRaw || "", {
			zone: "America/New_York",
		});

		if (!pmOpen.isValid || !mOpen.isValid) {
			return "closed"; // safety fallback
		}

		if (now >= pmOpen && now < mOpen) return "pre-market";
		if (now >= mOpen && now < mClose) return "open";
		if (now >= mClose && now < ahClose) return "after-hours";

		return "closed";
	}

	private scheduleNextPoll(): void {
		if (!this.isRunning) return;

		const intervalMs = this.getPollIntervalMs();
		this.timeoutId = setTimeout(() => this.poll(), intervalMs);
	}

	/**
	 * Adaptive polling interval.
	 * • No data yet → warnIntervalSec
	 * • Has data → use liveIntervalSec or closedIntervalSec based on CURRENT (real or heuristic) phase
	 */
	private getPollIntervalMs(): number {
		if (!this.lastData) {
			return this.warnIntervalSec * 1000;
		}

		const phase = this.determinePhase(this.lastData);
		return phase === "closed"
			? this.closedIntervalSec * 1000
			: this.liveIntervalSec * 1000;
	}

	private maybeLogWarn(): void {
		const now = Date.now();
		if (now - this.lastWarnTime >= this.warnIntervalSec * 1000) {
			logger.warn(
				"[MarketMonitor] MarketStatus fetch failed – using heuristic data",
				{
					failures: this.failureCount,
				},
			);
			this.lastWarnTime = now;
		}
	}
}
