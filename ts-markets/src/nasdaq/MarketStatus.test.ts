// =============================================
// FILE: ts-markets/src/nasdaq/MarketStatus.test.ts
// PURPOSE: Exhaustive test suite for MarketStatus
// Covers: Success, Logic Errors, Transport Errors, Schema Validation, Unexpected Exceptions, Sleep Duration Logic.
// Uses MSW for API mocking and vi.setSystemTime for date mocking.
// =============================================

import { DateTime } from "luxon";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { MarketStatus, type NasdaqMarketInfo } from "./MarketStatus";

const server = setupServer(
	// 1. Standard Success (Open Market)
	http.get("https://api.nasdaq.com/api/market-info", () => {
		return HttpResponse.json({
			status: { rCode: 200, bCodeMessage: null, developerMessage: null },
			data: {
				country: "U.S.",
				marketIndicator: "Market Open",
				uiMarketIndicator: "Market Open",
				marketCountDown: "Market Closes in 3H 37M",
				preMarketOpeningTime: "Mar 9, 2026 04:00 AM ET",
				preMarketClosingTime: "Mar 9, 2026 09:30 AM ET",
				marketOpeningTime: "Mar 9, 2026 09:30 AM ET",
				marketClosingTime: "Mar 9, 2026 04:00 PM ET",
				afterHoursMarketOpeningTime: "Mar 9, 2026 04:00 PM ET",
				afterHoursMarketClosingTime: "Mar 9, 2026 08:00 PM ET",
				previousTradeDate: "Mar 6, 2026",
				nextTradeDate: "Mar 10, 2026",
				isBusinessDay: true,
				mrktStatus: "Open",
				mrktCountDown: "Closes in 3H 37M",
				pmOpenRaw: "2026-03-09T04:00:00",
				ahCloseRaw: "2026-03-09T20:00:00",
				openRaw: "2026-03-09T09:30:00",
				closeRaw: "2026-03-09T16:00:00",
			},
		});
	}),
);

vi.mock("@ckir/corelib", () => ({
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	},
}));

describe("MarketStatus", () => {
	beforeAll(() => server.listen());
	afterEach(() => {
		server.resetHandlers();
		vi.clearAllMocks();
		vi.useRealTimers();
	});
	afterAll(() => server.close());

	describe("getStatus()", () => {
		it("should return success with valid data", async () => {
			const result = await MarketStatus.getStatus();

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.mrktStatus).toBe("Open");
				expect(result.value.isBusinessDay).toBe(true);
			}
			expect(
				vi.mocked(require("@ckir/corelib").logger.debug),
			).toHaveBeenCalledWith("[MarketStatus] Schema validated successfully");
		});

		it("should handle Nasdaq logic errors (rCode !== 200)", async () => {
			server.use(
				http.get("https://api.nasdaq.com/api/market-info", () => {
					return HttpResponse.json({
						status: {
							rCode: 400,
							bCodeMessage: [{ code: "ERR", errorMessage: "Error" }],
							developerMessage: "Bad",
						},
						data: null,
					});
				}),
			);

			const result = await MarketStatus.getStatus();

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.reason.message).toContain("code: ERR = Error");
			}
		});

		it("should handle transport errors (e.g., 404)", async () => {
			server.use(
				http.get(
					"https://api.nasdaq.com/api/market-info",
					() => new HttpResponse(null, { status: 404 }),
				),
			);

			const result = await MarketStatus.getStatus();

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.reason.message).toBe("Transport Error");
			}
			expect(
				vi.mocked(require("@ckir/corelib").logger.error),
			).toHaveBeenCalled();
		});

		it("should handle malformed schema (missing fields)", async () => {
			server.use(
				http.get("https://api.nasdaq.com/api/market-info", () => {
					return HttpResponse.json({
						status: { rCode: 200 },
						data: { mrktStatus: "Open" }, // Missing nextTradeDate, pmOpenRaw, etc.
					});
				}),
			);

			const result = await MarketStatus.getStatus();

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.reason.message).toBe(
					"STRICT SCHEMA VALIDATION FAILED: Missing required fields",
				);
			}
			expect(
				vi.mocked(require("@ckir/corelib").logger.fatal),
			).toHaveBeenCalled();
		});

		it("should handle unexpected exceptions", async () => {
			server.use(
				http.get("https://api.nasdaq.com/api/market-info", () => {
					throw new Error("Unexpected");
				}),
			);

			const result = await MarketStatus.getStatus();

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.reason.message).toBe("Unexpected");
			}
			expect(
				vi.mocked(require("@ckir/corelib").logger.error),
			).toHaveBeenCalled();
		});
	});

	describe("getSleepDuration()", () => {
		const mockData: NasdaqMarketInfo = {
			country: "U.S.",
			marketIndicator: "Market Closed",
			uiMarketIndicator: "Market Closed",
			marketCountDown: "Market Opens in 1D 18H 5M",
			preMarketOpeningTime: "Mar 9, 2026 04:00 AM ET",
			preMarketClosingTime: "Mar 9, 2026 09:30 AM ET",
			marketOpeningTime: "Mar 9, 2026 09:30 AM ET",
			marketClosingTime: "Mar 9, 2026 04:00 PM ET",
			afterHoursMarketOpeningTime: "Mar 9, 2026 04:00 PM ET",
			afterHoursMarketClosingTime: "Mar 9, 2026 08:00 PM ET",
			previousTradeDate: "Mar 6, 2026",
			nextTradeDate: "Mar 9, 2026",
			isBusinessDay: true,
			mrktStatus: "Closed",
			mrktCountDown: "Opens in 1D 18H 5M",
			pmOpenRaw: "2026-03-09T04:00:00",
			ahCloseRaw: "2026-03-09T20:00:00",
			openRaw: "2026-03-09T09:30:00",
			closeRaw: "2026-03-09T16:00:00",
		};

		it("should return 0 if market is Open", () => {
			const data = { ...mockData, mrktStatus: "Open" };
			expect(MarketStatus.getSleepDuration(data)).toBe(0);
		});

		it("should calculate to pre-market if before pmOpen", () => {
			vi.setSystemTime(
				DateTime.fromISO("2026-03-09T03:00:00", {
					zone: "America/New_York",
				}).toJSDate(),
			);

			const ms = MarketStatus.getSleepDuration(mockData);
			expect(ms).toBe(3600000); // 1 hour in ms
			expect(
				vi.mocked(require("@ckir/corelib").logger.debug),
			).toHaveBeenCalled();
		});

		it("should calculate to market open if after pmOpen but before open", () => {
			vi.setSystemTime(
				DateTime.fromISO("2026-03-09T05:00:00", {
					zone: "America/New_York",
				}).toJSDate(),
			);

			const ms = MarketStatus.getSleepDuration(mockData);
			expect(ms).toBe(4.5 * 3600000); // 4.5 hours
		});

		it("should use nextTradeDate if target in past (e.g., after hours)", () => {
			vi.setSystemTime(
				DateTime.fromISO("2026-03-09T21:00:00", {
					zone: "America/New_York",
				}).toJSDate(),
			);
			const data = { ...mockData, nextTradeDate: "Mar 10, 2026" };

			const ms = MarketStatus.getSleepDuration(data);
			expect(ms).toBe(7 * 3600000); // From 21:00 to 04:00 next day = 7 hours
		});

		it("should fallback to 300000ms if nextTradeDate invalid", () => {
			vi.setSystemTime(
				DateTime.fromISO("2026-03-09T21:00:00", {
					zone: "America/New_York",
				}).toJSDate(),
			);
			const data = { ...mockData, nextTradeDate: "Invalid" };

			const ms = MarketStatus.getSleepDuration(data);
			expect(ms).toBe(300000);
			expect(
				vi.mocked(require("@ckir/corelib").logger.warn),
			).toHaveBeenCalled();
		});

		it("should return min 60000ms if diff <=0", () => {
			vi.setSystemTime(
				DateTime.fromISO("2026-03-09T04:00:00", {
					zone: "America/New_York",
				}).toJSDate(),
			); // Exactly at pmOpen

			const ms = MarketStatus.getSleepDuration(mockData);
			expect(ms).toBe(60000);
		});
	});
});
