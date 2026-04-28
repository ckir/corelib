/**
 * @file ts-cloud/src/markets/nasdaq/HistoricalCloud.test.ts
 * @description Unit tests for the HistoricalCloud edge router.
 */

import { Historical } from "@ckir/corelib-markets";
import { describe, expect, it, vi } from "vitest";
import { historicalRouter } from "./HistoricalCloud";

// Mock the Historical module from corelib-markets
vi.mock("@ckir/corelib-markets", () => ({
	Historical: {
		getData: vi.fn(),
	},
}));

describe("HistoricalCloud Router", () => {
	const mockOptions = { period1: "2023-01-01", interval: "1d" };
	const mockQuotes = [
		{
			symbol: "AAPL",
			date: "2023-01-01",
			open: 150,
			high: 155,
			low: 145,
			close: 150,
			volume: 1000,
			adjClose: 150,
		},
	];

	it("should return 400 if the request body is missing", async () => {
		const res = await historicalRouter.request("/", {
			method: "POST",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.status).toBe("error");
		expect(body.reason.message).toContain("Missing request body");
	});

	it("should handle a successful single historical data request", async () => {
		// Setup mock to return a success RequestResult
		vi.mocked(Historical.getData).mockResolvedValueOnce({
			status: "success",
			value: mockQuotes,
		});

		const res = await historicalRouter.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				symbol: "AAPL",
				options: mockOptions,
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		// Transparent Proxy Pattern: returns the cleaned value directly
		expect(body).toEqual(mockQuotes);
		expect(Historical.getData).toHaveBeenCalledWith("AAPL", mockOptions);
	});

	it("should return 500 and the error object if a single request fails", async () => {
		const errorResult = {
			status: "error",
			reason: { message: "Symbol not found" },
		};
		vi.mocked(Historical.getData).mockResolvedValueOnce(errorResult as any);

		const res = await historicalRouter.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				symbol: "INVALID",
				options: mockOptions,
			}),
		});

		expect(res.status).toBe(500);
		const body = await res.json();
		expect(body).toEqual(errorResult);
	});

	it("should handle bulk historical data requests in parallel", async () => {
		const bulkRequests = [
			{ symbol: "AAPL", options: mockOptions },
			{ symbol: "MSFT", options: mockOptions },
		];

		vi.mocked(Historical.getData)
			.mockResolvedValueOnce({
				status: "success",
				value: mockQuotes,
			} as any)
			.mockResolvedValueOnce({
				status: "success",
				value: mockQuotes,
			} as any);

		const res = await historicalRouter.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requests: bulkRequests }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as any;

		// Bulk requests return an array of RequestResult objects
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(2);
		expect(body[0].status).toBe("success");
		expect(body[1].status).toBe("success");
	});

	it("should return 400 for invalid payload structure", async () => {
		const res = await historicalRouter.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ wrongKey: "data" }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.reason.message).toContain("Invalid payload");
	});

	it("should return 500 if the Historical module throws an exception", async () => {
		vi.mocked(Historical.getData).mockRejectedValueOnce(new Error("Crash"));

		const res = await historicalRouter.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ symbol: "AAPL", options: mockOptions }),
		});

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.reason.message).toBe("Internal Edge Proxy Error");
	});
});
