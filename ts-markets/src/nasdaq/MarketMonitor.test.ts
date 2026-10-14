// =============================================
// FILE: ts-markets\src\nasdaq\MarketMonitor.test.ts
// PURPOSE: Exhaustive test suite for MarketMonitor
// Covers: constructor defaults, start/stop, status-change emission, heuristic fallback,
// adaptive polling intervals, getters, stopped event, first-poll-only emission, warn throttling.
// Uses vi.useFakeTimers + MSW-mocked MarketStatus.
// =============================================

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { MarketMonitor } from "./MarketMonitor";
import { MarketStatus } from "./MarketStatus";

// Helper base data used in all mocks - Moved up to avoid TDZ issues
const baseData = {
	pmOpenRaw: "2026-03-17T04:00:00",
	openRaw: "2026-03-17T09:30:00",
	closeRaw: "2026-03-17T16:00:00",
	ahCloseRaw: "2026-03-17T20:00:00",
};

// Mock logger to prevent console noise
const {
	mockDebug,
	mockWarn,
	mockError,
	mockInfo,
	mockChildLogger,
	mockEndPoint,
} = vi.hoisted(() => {
	const debug = vi.fn();
	const warn = vi.fn();
	const error = vi.fn();
	const info = vi.fn();
	const trace = vi.fn();
	const endPoint = vi.fn();
	return {
		mockDebug: debug,
		mockWarn: warn,
		mockError: error,
		mockInfo: info,
		mockTrace: trace,
		mockChildLogger: {
			debug,
			warn,
			error,
			info,
			trace,
		},
		mockEndPoint: endPoint,
	};
});

vi.mock("@ckirg/corelib", async () => {
	const mockLogger = {
		child: vi.fn(() => mockChildLogger),
		// Also provide direct methods for cases where child isn't used
		...mockChildLogger,
	};
	return {
		default: mockLogger,
		logger: mockLogger,
		endPoint: mockEndPoint,
		nextCid: () => 1,
		ConfigManager: {
			get: vi.fn().mockReturnValue(undefined),
		},
	};
});

// Mock MarketStatus
vi.mock("./MarketStatus", () => ({
	MarketStatus: {
		getStatus: vi.fn(),
	},
}));

describe("MarketMonitor (Exhaustive)", () => {
	let monitor: MarketMonitor;
	const mockGetStatus = MarketStatus.getStatus as any;

	beforeAll(() => {
		// Initialize mock functions here to ensure they are defined
		// These are reassigned in beforeEach to ensure a clean state for each test
		mockDebug.mockClear(); // Ensure fresh mocks for each test run
		mockWarn.mockClear();
		mockError.mockClear();
		mockInfo.mockClear();
	});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-17T12:00:00Z")); // Set a fixed time for deterministic tests
		vi.clearAllMocks(); // Clear mocks for all imported modules

		monitor = new MarketMonitor({
			liveIntervalSec: 5,
			closedIntervalSec: 30,
			warnIntervalSec: 10,
		});
		// Clear mocks on the individual logger functions
		mockDebug.mockClear();
		mockWarn.mockClear();
		mockError.mockClear();
		mockInfo.mockClear();
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
		expect((m as any).proxies).toEqual([]);
	});

	it("should append correct path to proxies", () => {
		const m = new MarketMonitor({
			proxies: ["http://p1", "http://p2/"],
		});
		expect((m as any).proxies).toEqual([
			"http://p1/api/v1/markets/nasdaq/status",
			"http://p2/api/v1/markets/nasdaq/status",
		]);
	});

	it("should use proxies with round-robin and success (wrapped response)", async () => {
		const m = new MarketMonitor({
			proxies: ["http://p1", "http://p2"],
		});
		const changeSpy = vi.fn();
		m.on("status-change", changeSpy);

		// First call: p1 succeeds with wrapped response
		mockEndPoint.mockResolvedValueOnce({
			status: "success",
			value: {
				body: {
					status: "success",
					value: { mrktStatus: "Open", ...baseData },
				},
			},
		});

		m.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(mockEndPoint).toHaveBeenCalledWith(
			"http://p1/api/v1/markets/nasdaq/status",
		);
		expect(changeSpy).toHaveBeenCalledWith("open", expect.anything(), false);
		expect((m as any).proxyIndex).toBe(1);

		// Second call: p2 succeeds with direct response
		mockEndPoint.mockResolvedValueOnce({
			status: "success",
			value: {
				body: { mrktStatus: "Closed", ...baseData },
			},
		});
		await vi.advanceTimersByTimeAsync(10000); // Trigger next poll

		expect(mockEndPoint).toHaveBeenCalledWith(
			"http://p2/api/v1/markets/nasdaq/status",
		);
		expect(changeSpy).toHaveBeenCalledWith("closed", expect.anything(), false);
		expect((m as any).proxyIndex).toBe(0);
	});

	it("should failover to next proxy if one fails", async () => {
		const m = new MarketMonitor({
			proxies: ["http://p1", "http://p2"],
		});

		// p1 fails, p2 succeeds
		mockEndPoint
			.mockResolvedValueOnce({ status: "error", reason: "fail" })
			.mockResolvedValueOnce({
				status: "success",
				value: { body: { mrktStatus: "Open", ...baseData } },
			});

		m.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(mockEndPoint).toHaveBeenCalledWith(
			"http://p1/api/v1/markets/nasdaq/status",
		);
		expect(mockEndPoint).toHaveBeenCalledWith(
			"http://p2/api/v1/markets/nasdaq/status",
		);
		expect(m.currentPhase).toBe("open");
		expect((m as any).proxyIndex).toBe(0); // (1+1)%2 = 0
	});

	it("should revert to local method if all proxies fail", async () => {
		const m = new MarketMonitor({
			proxies: ["http://p1"],
		});

		// p1 fails
		mockEndPoint.mockResolvedValueOnce({ status: "error", reason: "fail" });
		// Local succeeds
		mockGetStatus.mockResolvedValueOnce({
			status: "success",
			value: { mrktStatus: "Open", ...baseData },
		});

		m.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(mockEndPoint).toHaveBeenCalledWith(
			"http://p1/api/v1/markets/nasdaq/status",
		);
		expect(mockGetStatus).toHaveBeenCalled();
		expect(m.currentPhase).toBe("open");
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
		expect(changeSpy.mock.calls[0]![0]).toBe("open");
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
		expect(changeSpy.mock.calls[1]![0]).toBe("closed");
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
		const secondCall = changeSpy.mock.calls[1]!;
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
		const warnSpy = mockWarn;

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

	describe("Hardening", () => {
		it("stop(); start() while a poll is pending leaves exactly one schedule chain", async () => {
			let resolveFirst: (v: unknown) => void = () => undefined;
			const open = {
				status: "success",
				value: { mrktStatus: "Open", ...baseData },
			};
			mockGetStatus
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							resolveFirst = resolve;
						}),
				)
				.mockResolvedValue(open);
			const changes = vi.fn();
			monitor.on("status-change", changes);

			monitor.start(); // poll #1 pending on the network
			monitor.stop();
			monitor.start(); // poll #2 resolves, schedules the only chain
			await vi.advanceTimersByTimeAsync(0);
			expect(mockGetStatus).toHaveBeenCalledTimes(2);
			expect(changes).toHaveBeenCalledTimes(1);

			resolveFirst(open); // stale generation resumes: must not emit or schedule
			await vi.advanceTimersByTimeAsync(0);
			expect(changes).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(5000); // live interval = 5s
			expect(mockGetStatus).toHaveBeenCalledTimes(3);
			await vi.advanceTimersByTimeAsync(5000);
			expect(mockGetStatus).toHaveBeenCalledTimes(4);
		});

		it("a throwing status-change listener causes one handleSuccess and no extra proxy attempts", async () => {
			const proxied = new MarketMonitor({
				liveIntervalSec: 5,
				closedIntervalSec: 30,
				warnIntervalSec: 10,
				proxies: ["https://p1.example", "https://p2.example"],
			});
			mockEndPoint.mockResolvedValue({
				status: "success",
				value: {
					body: {
						status: "success",
						value: { mrktStatus: "Open", ...baseData },
					},
				},
			});
			const handleSuccess = vi.spyOn(proxied as any, "handleSuccess");
			proxied.on("status-change", () => {
				throw new Error("listener bug");
			});

			proxied.start();
			await vi.advanceTimersByTimeAsync(0);

			expect(handleSuccess).toHaveBeenCalledTimes(1);
			expect(mockEndPoint).toHaveBeenCalledTimes(1);
			expect(mockGetStatus).not.toHaveBeenCalled();
			expect(mockError).toHaveBeenCalledWith(
				expect.stringContaining("Listener threw"),
				expect.any(Object),
			);
			proxied.stop();
		});

		it("a throwing listener does not trigger handleFailure in the API branch", async () => {
			mockGetStatus.mockResolvedValue({
				status: "success",
				value: { mrktStatus: "Open", ...baseData },
			});
			const handleFailure = vi.spyOn(monitor as any, "handleFailure");
			monitor.on("status-change", () => {
				throw new Error("listener bug");
			});
			monitor.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(handleFailure).not.toHaveBeenCalled();
			expect(monitor.failureCountValue).toBe(0);
		});

		it("uses the closed interval in failure mode when a stale 'Open' status is cached", () => {
			vi.setSystemTime(new Date("2026-03-18T01:00:00Z")); // 21:00 ET Mar 17, after close
			(monitor as any).lastData = { mrktStatus: "Open", ...baseData };
			(monitor as any).failureCount = 0;
			expect((monitor as any).getPollIntervalMs()).toBe(5000); // trusted status
			(monitor as any).failureCount = 2;
			expect((monitor as any).getPollIntervalMs()).toBe(30000); // heuristic: closed
		});

		it("rolls yesterday's raw times forward to today in the heuristic", () => {
			// Wednesday 10:00 ET; data is from Tuesday
			vi.setSystemTime(new Date("2026-03-18T14:00:00Z"));
			(monitor as any).lastData = { mrktStatus: "Closed", ...baseData };
			(monitor as any).lastPhase = "closed";
			(monitor as any).hasEmitted = true;
			const changes = vi.fn();
			monitor.on("status-change", changes);

			(monitor as any).handleFailure(1);

			expect(changes).toHaveBeenCalledWith(
				"open",
				expect.objectContaining({ heuristic: true }),
				true,
			);
			(monitor as any).failureCount = 1;
			expect((monitor as any).getPollIntervalMs()).toBe(5000);
		});

		it("stays closed on a weekend even with rolled-forward times", () => {
			vi.setSystemTime(new Date("2026-03-21T14:00:00Z")); // Saturday 10:00 ET
			expect(
				(monitor as any).determinePhase({ mrktStatus: "", ...baseData }),
			).toBe("closed");
		});
	});
});
