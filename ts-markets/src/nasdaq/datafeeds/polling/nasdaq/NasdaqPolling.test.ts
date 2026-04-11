import { logger } from "@ckir/corelib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NasdaqPolling } from "./NasdaqPolling";

// Mock the dependencies
vi.mock("@ckir/corelib", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

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
			expect(logger.warn).toHaveBeenCalledWith(
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
			poller.setApiInterval(newInterval); // Call 2 (immediate restart)

			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(newInterval);
			expect(mockApiInstance.getNasdaqQuote).toHaveBeenCalledTimes(3);
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
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("Error fetching quote"),
				expect.objectContaining({ error: errorReason }),
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
			expect(logger.error).toHaveBeenCalledWith(
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
});
