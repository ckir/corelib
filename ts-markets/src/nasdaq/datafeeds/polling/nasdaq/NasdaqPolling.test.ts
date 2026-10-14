import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NasdaqPolling } from "./NasdaqPolling";

// Mock logger to prevent console noise
const { mockTrace, mockDebug, mockWarn, mockError, mockInfo, mockChildLogger } =
	vi.hoisted(() => {
		const trace = vi.fn();
		const debug = vi.fn();
		const warn = vi.fn();
		const error = vi.fn();
		const info = vi.fn();
		return {
			mockTrace: trace,
			mockDebug: debug,
			mockWarn: warn,
			mockError: error,
			mockInfo: info,
			mockChildLogger: {
				trace,
				debug,
				warn,
				error,
				info,
			},
		};
	});

// Mock the dependencies
vi.mock("@ckirg/corelib", async () => {
	const mockLogger = {
		child: vi.fn(() => mockChildLogger),
		...mockChildLogger,
	};
	return {
		default: mockLogger,
		logger: mockLogger,
		nextCid: () => 1,
	};
});

vi.mock("../../../ApiNasdaqQuotes", () => {
	const ApiNasdaqQuotes = vi.fn();
	ApiNasdaqQuotes.prototype.getNasdaqQuote = vi.fn();
	ApiNasdaqQuotes.prototype.close = vi.fn();
	return { ApiNasdaqQuotes };
});

describe("NasdaqPolling", () => {
	let poller: NasdaqPolling;
	let mockApiInstance: any;

	const sampleProxies = ["http://proxy1.com", "http://proxy2.com"];
	const interval = 5000;

	beforeEach(() => {
		vi.useFakeTimers();
		poller = new NasdaqPolling(interval, sampleProxies);
		// @ts-expect-error - accessing private for testing purposes
		mockApiInstance = poller.nasdaqQuotes;

		// Clear mocks on the individual logger functions
		mockTrace.mockClear();
		mockDebug.mockClear();
		mockWarn.mockClear();
		mockError.mockClear();
		mockInfo.mockClear();
	});

	afterEach(() => {
		if (poller) poller.stop();
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe("Subscription Management", () => {
		it("should add symbols and normalize them to uppercase", () => {
			poller.subscribe(["aapl", "msft"]);
			// @ts-expect-error
			expect(poller.subscriptions.has("AAPL")).toBe(true);
			// @ts-expect-error
			expect(poller.subscriptions.has("MSFT")).toBe(true);
		});

		it("should remove specific symbols", () => {
			poller.subscribe(["AAPL", "TSLA"]);
			poller.unsubscribe(["AAPL"]);
			// @ts-expect-error
			expect(poller.subscriptions.has("AAPL")).toBe(false);
			// @ts-expect-error
			expect(poller.subscriptions.has("TSLA")).toBe(true);
		});

		it("should clear all subscriptions and stop polling", () => {
			const stopSpy = vi.spyOn(poller, "stop");
			poller.subscribe(["AAPL"]);
			poller.clear();
			// @ts-expect-error
			expect(poller.subscriptions.size).toBe(0);
			expect(stopSpy).toHaveBeenCalled();
		});
	});

	describe("Polling Lifecycle", () => {
		it("should perform an immediate poll on start", () => {
			poller.subscribe(["AAPL"]);
			mockApiInstance.getNasdaqQuote.mockResolvedValue([]);

			poller.start();

			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledWith(["AAPL"]);
		});

		it("should poll repeatedly based on interval", async () => {
			poller.subscribe(["AAPL"]);
			mockApiInstance.getNasdaqQuote.mockResolvedValue([]);

			poller.start();
			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(interval);
			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(interval);
			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(3);
		});

		it("should not start multiple intervals if start() is called twice", () => {
			poller.start();
			poller.start();
			expect(mockWarn).toHaveBeenCalledWith(
				expect.stringContaining("already active"),
			);
		});

		it("should stop polling when stop() is called", async () => {
			poller.subscribe(["AAPL"]);
			poller.start();
			poller.stop();

			await vi.advanceTimersByTimeAsync(interval);
			// Only the initial poll from start() should have occurred
			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(1);
		});

		it("should restart polling with new interval when setApiInterval is called while running", async () => {
			poller.subscribe(["AAPL"]);
			poller.start(); // Call 1 (immediate)

			const newInterval = 2000;
			// The restart's immediate poll is skipped: call 1 is still in flight (no overlap).
			poller.setApiInterval(newInterval);

			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(newInterval);
			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(2);
		});
	});

	describe("Data and Error Emission", () => {
		it("should emit 'data' event for successful quote fetches", async () => {
			const mockData = { symbol: "AAPL", lastSalePrice: "150.00" };
			mockApiInstance.getNasdaqQuote.mockResolvedValue([
				{ status: "success", value: mockData },
			]);

			const dataSpy = vi.fn();
			poller.on("data", dataSpy);

			poller.subscribe(["AAPL"]);
			// @ts-expect-error - triggering private poll for isolation
			await poller.poll();

			expect(dataSpy).toHaveBeenCalledWith(mockData);
			expect(mockTrace).toHaveBeenCalledWith(
				"poll: start",
				expect.objectContaining({
					cid: expect.any(Number),
					requested: expect.any(Number),
				}),
			);
			expect(mockTrace).toHaveBeenCalledWith(
				"poll: done",
				expect.objectContaining({
					cid: expect.any(Number),
					durationMs: expect.any(Number),
					ok: expect.any(Number),
					failed: expect.any(Number),
					missing: expect.any(Number),
				}),
			);
			// per-item trace carries cid + symbol identity (results mirror input order)
			expect(mockTrace).toHaveBeenCalledWith(
				"poll: result",
				expect.objectContaining({
					cid: expect.any(Number),
					symbol: "AAPL",
					status: "success",
				}),
			);
		});

		it("should emit 'error' event and log when an individual quote fails", async () => {
			const errorReason = "Network Timeout";
			mockApiInstance.getNasdaqQuote.mockResolvedValue([
				{ status: "error", reason: errorReason },
			]);

			const errorSpy = vi.fn();
			poller.on("error", errorSpy);

			poller.subscribe(["AAPL"]);
			// @ts-expect-error
			await poller.poll();

			expect(errorSpy).toHaveBeenCalledWith(errorReason);
			expect(mockError).toHaveBeenCalledWith(
				expect.stringContaining("Error fetching quote"),
				// The logged error is now serializeError(reason) — a structured,
				// JSON-safe object (Errors no longer collapse to {}; non-Error reasons
				// become a NonError wrapper preserving the value in .message).
				expect.objectContaining({
					error: expect.objectContaining({
						message: expect.stringContaining(errorReason),
					}),
				}),
			);
		});

		it("should catch and emit unexpected exceptions during polling", async () => {
			const fatalError = new Error("API Crash");
			mockApiInstance.getNasdaqQuote.mockRejectedValue(fatalError);

			const errorSpy = vi.fn();
			poller.on("error", errorSpy);

			poller.subscribe(["AAPL"]);
			// @ts-expect-error
			await poller.poll();

			expect(errorSpy).toHaveBeenCalled();
			expect(mockError).toHaveBeenCalledWith(
				expect.stringContaining("Polling execution failed"),
				expect.any(Object),
			);
		});

		it("should not call API if subscription list is empty", async () => {
			// @ts-expect-error
			await poller.poll();
			expect(mockApiInstance.getNasdaqQuote).not.toHaveBeenCalled();
		});
	});

	describe("Hardening", () => {
		it("does not throw or reject when a quote fails and nobody listens for 'error'", async () => {
			mockApiInstance.getNasdaqQuote.mockResolvedValue([
				{ status: "error", reason: "Network Timeout" },
			]);
			poller.subscribe(["AAPL"]);
			// @ts-expect-error - private
			await expect(poller.poll()).resolves.toBeUndefined();
			expect(mockError).toHaveBeenCalled();
		});

		it("does not throw when the fetch itself rejects and nobody listens for 'error'", async () => {
			mockApiInstance.getNasdaqQuote.mockRejectedValue(new Error("boom"));
			poller.subscribe(["AAPL"]);
			// @ts-expect-error - private
			await expect(poller.poll()).resolves.toBeUndefined();
			expect(mockError).toHaveBeenCalledWith(
				expect.stringContaining("Polling execution failed"),
				expect.any(Object),
			);
		});

		it("does not start a second poll while one is in flight", async () => {
			let resolveFetch: (v: unknown[]) => void = () => undefined;
			mockApiInstance.getNasdaqQuote.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveFetch = resolve;
					}),
			);
			poller.subscribe(["AAPL"]);
			poller.start(); // initial poll, stays pending
			await vi.advanceTimersByTimeAsync(interval * 3);
			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(1);

			resolveFetch([]);
			await vi.advanceTimersByTimeAsync(interval);
			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(2);
		});
	});

	describe("stop() and restart while a poll is in flight", () => {
		it("does not emit data from a poll that was still in flight when stop() was called", async () => {
			let resolveQuote: (v: unknown) => void = () => {};
			mockApiInstance.getNasdaqQuote.mockImplementation(
				() =>
					new Promise((r) => {
						resolveQuote = r;
					}),
			);
			const onData = vi.fn();
			poller.on("data", onData);
			poller.subscribe(["AAPL"]);
			poller.start();
			await vi.advanceTimersByTimeAsync(0); // the poll is now awaiting its quote

			poller.stop();
			resolveQuote([{ status: "success", value: { symbol: "AAPL" } }]);
			await vi.advanceTimersByTimeAsync(0);

			expect(onData).not.toHaveBeenCalled();
		});

		it("runs the initial poll of a restarted session although the old poll is still in flight", async () => {
			mockApiInstance.getNasdaqQuote.mockImplementation(
				() => new Promise(() => {}),
			);
			poller.subscribe(["AAPL"]);
			poller.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(1);

			poller.stop();
			poller.start();
			await vi.advanceTimersByTimeAsync(0);

			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(2);
		});
	});
});
