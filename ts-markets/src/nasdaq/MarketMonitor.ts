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
import { ConfigManager, endPoint, logger, nextCid } from "@ckirg/corelib";
import { DateTime } from "luxon";
import { serializeError } from "serialize-error";
import { MarketStatus, type NasdaqMarketInfo } from "./MarketStatus.js";

const marketMonitorLogger = logger.child({ section: "MarketMonitor" });

const DEFAULT_LIVE_INTERVAL_SEC = 10;
const DEFAULT_CLOSED_INTERVAL_SEC = 3600;
const DEFAULT_WARN_INTERVAL_SEC = 60;

/**
 * Represents the current phase of the market.
 */
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
	private proxies: string[];
	private proxyIndex = 0;

	private timeoutId: NodeJS.Timeout | null = null;
	private isRunning = false;
	private lastData: NasdaqMarketInfo | null = null;
	private lastPhase: MarketPhase = "closed";
	private lastWarnTime = 0;
	private failureCount = 0;
	private hasEmitted = false;
	/** Bumped on every start()/stop(); a poll resumed from an older generation must not schedule or emit. */
	private generation = 0;

	/**
	 * @param {object} [options] - Configuration options.
	 * @param {number} [options.liveIntervalSec] - Polling interval in seconds when market is active.
	 * @param {number} [options.closedIntervalSec] - Polling interval in seconds when market is closed.
	 * @param {number} [options.warnIntervalSec] - Interval for logging fetch failure warnings.
	 * @param {string[]} [options.proxies] - Optional array of proxy URLs for status fetching.
	 */
	constructor(
		options: {
			liveIntervalSec?: number;
			closedIntervalSec?: number;
			warnIntervalSec?: number;
			proxies?: string[];
		} = {},
	) {
		super();
		this.liveIntervalSec =
			options.liveIntervalSec ??
			(ConfigManager.get("markets.nasdaq.monitor.liveIntervalSec") as
				| number
				| undefined) ??
			DEFAULT_LIVE_INTERVAL_SEC;
		this.closedIntervalSec =
			options.closedIntervalSec ??
			(ConfigManager.get("markets.nasdaq.monitor.closedIntervalSec") as
				| number
				| undefined) ??
			DEFAULT_CLOSED_INTERVAL_SEC;
		this.warnIntervalSec =
			options.warnIntervalSec ??
			(ConfigManager.get("markets.nasdaq.monitor.warnIntervalSec") as
				| number
				| undefined) ??
			DEFAULT_WARN_INTERVAL_SEC;
		this.proxies = (options.proxies || []).map((p) =>
			p.endsWith("/")
				? `${p}api/v1/markets/nasdaq/status`
				: `${p}/api/v1/markets/nasdaq/status`,
		);
	}

	/** Start the monitor. First emission happens only after the first successful poll. */
	start(): void {
		if (this.isRunning) return;
		this.isRunning = true;
		this.generation++;
		this.failureCount = 0;
		marketMonitorLogger.info(
			`Starting market status monitor. Using ${this.proxies.length} proxies.`,
		);
		this.runPoll(this.generation); // kick off the first poll immediately
	}

	/** Graceful shutdown. Clears timer and emits 'stopped'. */
	stop(): void {
		if (!this.isRunning) return;
		this.isRunning = false;
		this.generation++;
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = null;
		}
		marketMonitorLogger.info("Monitor stopped");
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

	/** Runs one poll, never rejecting (a rejected poll would otherwise be an unhandled rejection). */
	private runPoll(gen: number): void {
		this.poll(gen).catch((err: unknown) => {
			marketMonitorLogger.error("Poll crashed", { error: err });
			// Keep the loop alive for this generation.
			if (gen === this.generation) this.scheduleNextPoll(gen);
		});
	}

	/** True while `gen` is still the live generation (no stop()/start() since it began). */
	private isCurrent(gen: number): boolean {
		return this.isRunning && gen === this.generation;
	}

	/**
	 * Emits without letting a throwing listener alter poll control flow.
	 * Listeners run one by one so a faulty one neither skips the others nor throws into the caller.
	 */
	private safeEmit(event: string, ...args: unknown[]): void {
		for (const listener of this.rawListeners(event)) {
			try {
				(listener as (...a: unknown[]) => void).apply(this, args);
			} catch (err) {
				marketMonitorLogger.error("Listener threw", {
					event,
					error: serializeError(err),
				});
			}
		}
	}

	private async poll(gen: number = this.generation): Promise<void> {
		if (!this.isCurrent(gen)) return;

		// Flight-recorder: cid threads this whole poll cycle; source records which
		// path produced the phase (proxy/api live data vs time-based heuristic).
		const cid = nextCid();
		const startedAt = performance.now();
		marketMonitorLogger.trace("phase: poll", { cid });

		let success = false;
		let source: "proxy" | "api" | "heuristic" | "none" = "none";

		// 1. Try proxies first (if any)
		if (this.proxies.length > 0) {
			const startIdx = this.proxyIndex;
			for (let i = 0; i < this.proxies.length; i++) {
				const currentIdx = (startIdx + i) % this.proxies.length;
				const proxyUrl = this.proxies[currentIdx];
				let proxyData: NasdaqMarketInfo | null = null;

				try {
					const result = await endPoint<
						{ value?: NasdaqMarketInfo } & NasdaqMarketInfo
					>(proxyUrl);
					if (!this.isCurrent(gen)) return;
					if (
						result.status === "success" &&
						typeof result.value.body === "object" &&
						result.value.body !== null
					) {
						const body = result.value.body;
						// Proxies typically return { status: "success", value: { ...data } }
						// but some might return the data directly at the root of the body.
						const data = body.value || body;

						if (
							data &&
							typeof data === "object" &&
							data.mrktStatus &&
							data.openRaw
						) {
							proxyData = data as NasdaqMarketInfo;
						}
					}
					if (!proxyData) {
						marketMonitorLogger.warn(
							"Proxy status fetch failed or returned unexpected format",
							{ cid, proxyUrl },
						);
					}
				} catch (err) {
					if (!this.isCurrent(gen)) return;
					marketMonitorLogger.error("Error fetching via proxy", {
						cid,
						proxyUrl,
						error: serializeError(err),
					});
				}

				// Handled outside the fetch try/catch so listener/handler problems are
				// never mistaken for a proxy fetch error (and never trigger the next proxy).
				if (proxyData) {
					this.handleSuccess(proxyData, cid);
					// Update proxy index for next round robin (start with next one next time)
					this.proxyIndex = (currentIdx + 1) % this.proxies.length;
					success = true;
					source = "proxy";
					break;
				}
			}
		}

		// 2. Revert to local method if proxies failed or no proxies provided
		if (!success) {
			let apiData: NasdaqMarketInfo | null = null;
			try {
				const result = await MarketStatus.getStatus();
				if (result.status === "success") apiData = result.value;
			} catch (err) {
				if (!this.isCurrent(gen)) return;
				marketMonitorLogger.error("Unexpected poll error", {
					cid,
					error: serializeError(err),
				});
			}
			if (!this.isCurrent(gen)) return;

			if (apiData) {
				this.handleSuccess(apiData, cid);
				success = true;
				source = "api";
			} else {
				this.handleFailure(cid);
				source = this.lastData ? "heuristic" : "none";
			}
		}

		// Terminus every cycle (even when phase is unchanged) = feed-liveness +
		// which data source drove the current phase.
		marketMonitorLogger.trace("phase: poll-done", {
			cid,
			durationMs: performance.now() - startedAt,
			phase: this.lastPhase,
			heuristic: source === "heuristic",
			source,
		});

		this.scheduleNextPoll(gen);
	}

	private handleSuccess(data: NasdaqMarketInfo, cid: number): void {
		this.failureCount = 0;
		this.lastData = { ...data }; // keep a clean clone

		const from = this.lastPhase;
		const phase = this.determinePhase(data);
		const phaseChanged = phase !== this.lastPhase;

		this.lastPhase = phase;

		// Emit only after first successful poll AND on every subsequent phase change
		if (!this.hasEmitted || phaseChanged) {
			// THE gating decision. rawStatus = what the API said (catches mapping
			// bugs); heuristic:false = derived from live data, not a time guess.
			marketMonitorLogger.trace("phase: change", {
				cid,
				from,
				to: phase,
				heuristic: false,
				failureCount: 0,
				rawStatus: data.mrktStatus,
			});
			this.safeEmit("status-change", phase, { ...data }, false);
			this.hasEmitted = true;
		}
	}

	private handleFailure(cid: number): void {
		this.failureCount++;

		if (!this.lastData) {
			this.maybeLogWarn();
			return; // no data yet → nothing to emit
		}

		// Heuristic: compute phase from cached data + CURRENT time
		// We explicitly clear mrktStatus to force time-based calculation
		const from = this.lastPhase;
		const computedEt = DateTime.now().setZone("America/New_York").toISO();
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
			// heuristic:true = phase was GUESSED from time (computedEt) because the
			// fetch failed, not from live API data — the key wrong-phase signal.
			marketMonitorLogger.trace("phase: change", {
				cid,
				from,
				to: phase,
				heuristic: true,
				failureCount: this.failureCount,
				rawStatus: "",
				computedEt,
			});
			this.safeEmit("status-change", phase, heuristicData, true);
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
		// The raw times carry the date of the poll that produced them; roll their wall-clock
		// time forward to today (NY) or the phase would be "closed" forever after midnight.
		const rollToToday = (raw: string | undefined): DateTime => {
			const t = DateTime.fromISO(raw || "", { zone: "America/New_York" });
			return t.isValid
				? t.set({ year: now.year, month: now.month, day: now.day })
				: t;
		};
		const pmOpen = rollToToday(data.pmOpenRaw);
		const mOpen = rollToToday(data.openRaw);
		const mClose = rollToToday(data.closeRaw);
		const ahClose = rollToToday(data.ahCloseRaw);

		if (!pmOpen.isValid || !mOpen.isValid) {
			return "closed"; // safety fallback
		}
		// Rolled-forward times would otherwise claim a session on weekends.
		if (now.weekday >= 6) return "closed";

		if (now >= pmOpen && now < mOpen) return "pre-market";
		if (now >= mOpen && now < mClose) return "open";
		if (now >= mClose && now < ahClose) return "after-hours";

		return "closed";
	}

	private scheduleNextPoll(gen: number = this.generation): void {
		if (!this.isCurrent(gen)) return;

		const intervalMs = this.getPollIntervalMs();
		this.timeoutId = setTimeout(() => this.runPoll(gen), intervalMs);
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

		// In failure mode the cached official status is stale; use the same status-cleared
		// (time-based) data the heuristic path uses.
		const phase = this.determinePhase(
			this.failureCount > 0
				? { ...this.lastData, mrktStatus: "" }
				: this.lastData,
		);
		return phase === "closed"
			? this.closedIntervalSec * 1000
			: this.liveIntervalSec * 1000;
	}

	private maybeLogWarn(): void {
		const now = Date.now();
		if (now - this.lastWarnTime >= this.warnIntervalSec * 1000) {
			marketMonitorLogger.warn(
				"MarketStatus fetch failed – using heuristic data",
				{
					failures: this.failureCount,
				},
			);
			this.lastWarnTime = now;
		}
	}
}
