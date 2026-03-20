/**
 * @file ts-cloud/src/markets/nasdaq/ApiNasdaqUnlimitedCloud.test.ts
 * @description Vitest suite for ApiNasdaqUnlimitedCloud.
 * Covers: Single URL requests, bulk endPoints, error mapping to 200 OK, and invalid payloads.
 */

import { ApiNasdaqUnlimited, type NasdaqResult } from "@ckir/corelib-markets";
import { describe, expect, it, vi } from "vitest";
import { nasdaqRouter } from "./ApiNasdaqUnlimitedCloud";

// Mock the corelib-markets dependency
vi.mock("@ckir/corelib-markets", () => ({
	ApiNasdaqUnlimited: {
		endPoint: vi.fn(),
	},
}));

describe("ApiNasdaqUnlimitedCloud (Edge)", () => {
	const MOCK_URL = "https://api.nasdaq.com/api/quote/AAPL/info";

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
		const body = (await res.json()) as NasdaqResult[];
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(2);
		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledWith("url1", {
			timeout: 1000,
		});
		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledWith("url2", {});
	});

	it("should return 200 OK even when Nasdaq returns a logic error", async () => {
		const mockError: NasdaqResult = {
			status: "error",
			reason: { message: "code: ERR1 = Symbol Not Found" },
		};

		vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValueOnce(mockError);

		const res = await nasdaqRouter.request("/", {
			method: "POST",
			body: JSON.stringify({ url: "invalid-symbol" }),
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as NasdaqResult;
		expect(body.status).toBe("error");
		if (body.status === "error") {
			expect(body.reason?.message).toContain("Symbol Not Found");
		}
	});

	it("should handle missing or invalid JSON body gracefully", async () => {
		const res = await nasdaqRouter.request("/", {
			method: "POST",
			body: "not-json",
			headers: { "Content-Type": "application/json" },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as NasdaqResult;
		expect(body.status).toBe("error");
		if (body.status === "error") {
			expect(body.reason?.message).toBe("Missing or invalid request body");
		}
	});

	it("should return error if neither url nor endPoints are provided", async () => {
		const res = await nasdaqRouter.request("/", {
			method: "POST",
			body: JSON.stringify({ foo: "bar" }),
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

	it("should return 200 OK and an error result if an internal exception occurs", async () => {
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
