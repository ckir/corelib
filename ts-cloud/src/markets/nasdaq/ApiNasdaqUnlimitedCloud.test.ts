/**
 * @file ts-cloud/src/markets/nasdaq/ApiNasdaqUnlimitedCloud.test.ts
 * @description Unit tests for the ApiNasdaqUnlimitedCloud Hono router.
 * Verified scenarios: Single URL proxying, bulk endpoint processing, validation errors, and crash resilience.
 */

import { ApiNasdaqUnlimited, type NasdaqResult } from "@ckir/corelib-markets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nasdaqRouter } from "./ApiNasdaqUnlimitedCloud";

// Mock the corelib-markets dependency to isolate router logic [cite: 8]
vi.mock("@ckir/corelib-markets", () => ({
	ApiNasdaqUnlimited: {
		endPoint: vi.fn(),
	},
}));

describe("ApiNasdaqUnlimitedCloud (Edge)", () => {
	const MOCK_URL = "https://api.nasdaq.com/api/quote/AAPL/info";

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("should return success for a single URL and maintain 200 OK status", async () => {
		const mockSuccess: NasdaqResult = {
			status: "success",
			value: { symbol: "AAPL", price: 150 },
		};
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValueOnce(mockSuccess);

		const res = await nasdaqRouter.request("/", {
			method: "POST",
			body: JSON.stringify({ url: MOCK_URL }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as NasdaqResult;
		expect(body).toEqual(mockSuccess);
		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledWith(MOCK_URL, {});
	});

	it("should handle bulk endPoints and return an array of results", async () => {
		const mockResults: NasdaqResult[] = [
			{ status: "success", value: { id: 1 } },
			{ status: "success", value: { id: 2 } },
		];
		vi.mocked(ApiNasdaqUnlimited.endPoint)
			.mockResolvedValueOnce(mockResults[0])
			.mockResolvedValueOnce(mockResults[1]);

		const res = await nasdaqRouter.request("/", {
			method: "POST",
			body: JSON.stringify({
				endPoints: [
					{ url: "url1", options: { timeout: 1000 } },
					{ url: "url2" },
				],
			}),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual(mockResults);
		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledTimes(2);
	});

	it("should return a validation error if payload is missing required fields", async () => {
		const res = await nasdaqRouter.request("/", {
			method: "POST",
			body: JSON.stringify({ invalid: "data" }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as NasdaqResult;
		expect(body.status).toBe("error");
		if (body.status === "error") {
			expect(body.reason?.message).toContain(
				"Expected 'url' (string) or 'endPoints'",
			);
		}
	});

	it("should return a fatal error result if an internal exception occurs", async () => {
		// Force a rejection to trigger the catch block
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockRejectedValueOnce(
			new Error("Edge Crash"),
		);

		const res = await nasdaqRouter.request("/", {
			method: "POST",
			body: JSON.stringify({ url: MOCK_URL }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as NasdaqResult;
		expect(body.status).toBe("error");
		if (body.status === "error") {
			expect(body.reason?.message).toBe("Internal Edge Proxy Error");
		}
	});
});
