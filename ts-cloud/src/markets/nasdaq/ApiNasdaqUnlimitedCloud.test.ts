/**
 * @file ts-cloud/src/markets/nasdaq/ApiNasdaqUnlimitedCloud.test.ts
 * @description Unit tests for the ApiNasdaqUnlimitedCloud Hono router.
 * Verified scenarios: Single URL proxying, bulk endpoint processing, validation errors, and crash resilience.
 */

import { endPoint } from "@ckir/corelib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nasdaqRouter } from "./ApiNasdaqUnlimitedCloud";

// Mock the corelib dependency
vi.mock("@ckir/corelib", () => ({
	endPoint: vi.fn(),
}));

// Mock the corelib-markets dependency
vi.mock("@ckir/corelib-markets", () => ({
	getNasdaqHeaders: vi.fn(() => ({ "x-test": "header" })),
}));

describe("ApiNasdaqUnlimitedCloud (Edge)", () => {
	const MOCK_URL = "https://api.nasdaq.com/api/quote/AAPL/info";

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("should return success for a single URL and maintain 200 OK status", async () => {
		const mockSuccess = {
			status: "success",
			value: { status: 200, body: { data: { symbol: "AAPL" } } },
		};
		vi.mocked(endPoint).mockResolvedValueOnce(mockSuccess as any);

		const res = await nasdaqRouter.request("/", {
			method: "POST",
			body: JSON.stringify({ url: MOCK_URL }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual(mockSuccess.value.body);
		expect(endPoint).toHaveBeenCalledWith(MOCK_URL, {
			headers: { "x-test": "header" },
		});
	});

	it("should handle bulk endPoints and return an array of results", async () => {
		const mockResults = [
			{ status: "success", value: { body: { id: 1 } } },
			{ status: "success", value: { body: { id: 2 } } },
		];
		vi.mocked(endPoint)
			.mockResolvedValueOnce(mockResults[0] as any)
			.mockResolvedValueOnce(mockResults[1] as any);

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
		expect(endPoint).toHaveBeenCalledTimes(2);
	});

	it("should return a validation error if payload is missing required fields", async () => {
		const res = await nasdaqRouter.request("/", {
			method: "POST",
			body: JSON.stringify({ invalid: "data" }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.status).toBe("error");
		expect(body.reason?.message).toContain(
			"Expected 'url' (string) or 'endPoints'",
		);
	});

	it("should return a fatal error result if an internal exception occurs", async () => {
		// Force a rejection to trigger the catch block
		vi.mocked(endPoint).mockRejectedValueOnce(new Error("Edge Crash"));

		const res = await nasdaqRouter.request("/", {
			method: "POST",
			body: JSON.stringify({ url: MOCK_URL }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.status).toBe("error");
		expect(body.reason?.message).toBe("Internal Edge Proxy Error");
	});
});
