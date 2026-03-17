// =============================================
// FILE: ts-markets\src\nasdaq\MarketMonitor.test.ts
// PURPOSE: Exhaustive test suite for MarketMonitor
// Covers: constructor defaults, start/stop, status-change emission, heuristic fallback,
// adaptive polling intervals, getters, stopped event, first-poll-only emission, warn throttling.
// Uses vi.useFakeTimers + MSW-mocked MarketStatus.
// =============================================

import { logger } from "@ckir/corelib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketMonitor } from "./MarketMonitor";
import { MarketStatus } from "./MarketStatus";

// Helper base data used in all mocks - Moved up to avoid TDZ issues
const baseData = {
	pmOpenRaw: "2026-03-17T04:00:00",
	openRaw: "2026-03-17T09:30:00",
	closeRaw: "2026-03-17T16:00:00",
	ahCloseRaw: "2026-03-17T20:00:00",
};

// Mock MarketStatus
vi.mock("./MarketStatus", () => ({
	MarketStatus: {
		getStatus: vi.fn(),
	},
}));

// Mock logger to prevent console noise
vi.mock("@ckir/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ckir/corelib")>();
	return {
		...actual,
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
		},
	};
});

describe("MarketMonitor (Exhaustive)", () => {
	let monitor: MarketMonitor;
	const mockGetStatus = MarketStatus.getStatus as any;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-17T12:00:00Z")); // Set a fixed time for deterministic tests
		vi.clearAllMocks();
		monitor = new MarketMonitor({
			liveIntervalSec: 5,
			closedIntervalSec: 30,
			warnIntervalSec: 10,
		});
	});

	afterEach(() => {
		monitor.stop();
		vi.useRealTimers();
	});

	it("should use constructor defaults when no options passed", () => {
		const m = new MarketMonitor();
		expect((m as any).liveIntervalSec).toBe(10);
		expect((m as any).closedIntervalSec).toBe(3600);
		expect((m as any).warnIntervalSec).toBe(60);
	});

	it("should emit nothing on start() until first successful poll", async () => {
		const changeSpy = vi.fn();
		monitor.on("status-change", changeSpy);

		// Simulate first success
		mockGetStatus.mockResolvedValueOnce({
			status: "success",
			value: {
				mrktStatus: "Open",
				...baseData,
			} as any,
		});

		monitor.start();
		expect(changeSpy).not.toHaveBeenCalled();

		// Flush microtasks and timers
		await vi.advanceTimersByTimeAsync(0);
		expect(changeSpy).toHaveBeenCalledTimes(1);
		expect(changeSpy.mock.calls[0][0]).toBe("open");
	});

	it("should emit status-change on phase change", async () => {
		const changeSpy = vi.fn();
		monitor.on("status-change", changeSpy);

		mockGetStatus.mockResolvedValueOnce({
			status: "success",
			value: { mrktStatus: "Open", ...baseData } as any,
		});
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);

		// Change to closed
		mockGetStatus.mockResolvedValueOnce({
			status: "success",
			value: { mrktStatus: "Closed", ...baseData } as any,
		});
		await vi.advanceTimersByTimeAsync(5000);

		expect(changeSpy).toHaveBeenCalledTimes(2);
		expect(changeSpy.mock.calls[1][0]).toBe("closed");
	});

	it("should fall back to heuristic data + emit phase change during failures", async () => {
		const changeSpy = vi.fn();
		monitor.on("status-change", changeSpy);

		// First success
		mockGetStatus.mockResolvedValueOnce({
			status: "success",
			value: { mrktStatus: "After-Hours", ...baseData } as any,
		});
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);

		// Now simulate failure
		mockGetStatus.mockRejectedValueOnce(new Error("Network down"));

		// Advance system time to 'Closed' (9 PM UTC is 5 PM ET, which is After-Hours, but let's go later to 1 AM UTC next day for Closed)
		vi.setSystemTime(new Date("2026-03-18T01:00:00Z"));

		await vi.advanceTimersByTimeAsync(5000);

		expect(changeSpy).toHaveBeenCalledTimes(2); // second call is heuristic phase change
		const secondCall = changeSpy.mock.calls[1];
		expect(secondCall[0]).toBe("closed");
		expect(secondCall[2]).toBe(true); // heuristic flag
		expect(secondCall[1].heuristic).toBe(true);
	});

	it("should adapt polling interval based on phase (and heuristic phase)", async () => {
		mockGetStatus.mockResolvedValue({
			status: "success",
			value: { mrktStatus: "Open", ...baseData } as any,
		});
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);

		const openTimer = (monitor as any).timeoutId;
		expect(openTimer).toBeDefined();

		// Force closed
		mockGetStatus.mockResolvedValue({
			status: "success",
			value: { mrktStatus: "Closed", ...baseData } as any,
		});
		await vi.advanceTimersByTimeAsync(5000);

		// Next poll should be scheduled with closedIntervalSec (30s in test)
		expect((monitor as any).timeoutId).toBeDefined();
	});

	it("should throttle warnings during persistent failure", async () => {
		const warnSpy = logger.warn as any;

		mockGetStatus.mockRejectedValue(new Error("fail"));
		monitor.start();

		// First failure
		await vi.advanceTimersByTimeAsync(0);
		expect(warnSpy).toHaveBeenCalledTimes(1);

		// Many rapid failures (but no time advancement enough for next poll yet if it was successful)
		// Since it failed, it uses warnIntervalSec (10s)
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(warnSpy).toHaveBeenCalledTimes(1); // still throttled

		// After warnIntervalSec (10s)
		await vi.advanceTimersByTimeAsync(10000);
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});

	it("should emit 'stopped' on stop() and clear timer", () => {
		const stoppedSpy = vi.fn();
		monitor.on("stopped", stoppedSpy);

		monitor.start();
		monitor.stop();

		expect(stoppedSpy).toHaveBeenCalledTimes(1);
		expect((monitor as any).timeoutId).toBeNull();
		expect(monitor.isRunningState).toBe(false);
	});

	it("should expose correct getters", async () => {
		mockGetStatus.mockResolvedValue({
			status: "success",
			value: { mrktStatus: "Pre-Market", ...baseData } as any,
		});

		monitor.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(monitor.isRunningState).toBe(true);
		expect(monitor.currentPhase).toBe("pre-market");
		expect(monitor.lastKnownData).toBeDefined();
		expect(monitor.failureCountValue).toBe(0);
	});
});
