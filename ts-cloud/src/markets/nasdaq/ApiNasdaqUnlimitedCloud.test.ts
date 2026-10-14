/**
 * @file ts-cloud/src/markets/nasdaq/ApiNasdaqUnlimitedCloud.test.ts
 * @description Unit tests for the ApiNasdaqUnlimitedCloud Hono router.
 * Verified scenarios: Single URL proxying, bulk endpoint processing, validation errors, and crash resilience.
 */

import { endPoint } from "@ckirg/corelib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nasdaqRouter } from "./ApiNasdaqUnlimitedCloud";

// Mock the corelib dependency
vi.mock("@ckirg/corelib", () => ({
	endPoint: vi.fn(),
}));

// Mock the corelib-markets dependency
vi.mock("@ckirg/corelib-markets", () => ({
	getNasdaqHeaders: vi.fn(() => ({ "x-test": "header" })),
}));

describe("ApiNasdaqUnlimitedCloud (Edge)", () => {
	const MOCK_URL = "https://api.nasdaq.com/api/quote/AAPL/info";
	const mockLogger = {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};

	nasdaqRouter.use("*", async (c, next) => {
		c.set("logger", mockLogger as any);
		await next();
	});

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
					{
						url: "https://api.nasdaq.com/api/quote/AAPL/info",
						options: { timeout: 1000 },
					},
					{ url: "https://api.nasdaq.com/api/quote/MSFT/info" },
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

	describe("Bulk limit", () => {
		const post = (endPoints: unknown[]) =>
			nasdaqRouter.request("/", {
				method: "POST",
				body: JSON.stringify({ endPoints }),
				headers: { "Content-Type": "application/json" },
			});
		const entries = (n: number) =>
			Array.from({ length: n }, () => ({ url: MOCK_URL }));

		it("should reject more than 20 endPoints with 400 before any fetch", async () => {
			const res = await post(entries(21));
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({
				status: "error",
				reason: { message: "Too many endPoints (max 20)" },
			});
			expect(endPoint).not.toHaveBeenCalled();
		});

		it("should accept exactly 20 endPoints", async () => {
			vi.mocked(endPoint).mockResolvedValue({
				status: "success",
				value: { status: 200, body: {} },
			} as any);
			const res = await post(entries(20));
			expect(res.status).toBe(200);
			expect(endPoint).toHaveBeenCalledTimes(20);
		});
	});

	describe("Status mapping", () => {
		const postUrl = () =>
			nasdaqRouter.request("/", {
				method: "POST",
				body: JSON.stringify({ url: MOCK_URL }),
				headers: { "Content-Type": "application/json" },
			});

		it("should not throw on an upstream 204 and return a contentful 200", async () => {
			vi.mocked(endPoint).mockResolvedValueOnce({
				status: "success",
				value: { status: 204, body: { ok: true } },
			} as any);
			const res = await postUrl();
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		});

		it("should map an error reason with status 304 to a valid status", async () => {
			vi.mocked(endPoint).mockResolvedValueOnce({
				status: "error",
				reason: { message: "nm", status: 304 },
			} as any);
			const res = await postUrl();
			expect(res.status).toBe(500);
		});
	});
});
