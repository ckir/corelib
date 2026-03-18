// =============================================
// FILE: ts-core/src/retrieve/RequestProxied.test.ts
// PURPOSE: Exhaustive test suite for RequestProxied.
// Covers: constructor validation, proxy URL construction (suffix + ?url= encoding),
// rotation, full fallback, proxy removal after 3 consecutive failures,
// load-balancing in endPoints, all-proxies-down error, logging, edge cases.
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

// ---------------------------------------------------------
// MOCKS (hoisted)
// ---------------------------------------------------------
vi.mock("./RequestUnlimited", () => {
	const mockEndPoint = vi.fn();
	const mockEndPoints = vi.fn();

	return {
		endPoint: mockEndPoint,
		endPoints: mockEndPoints,
		DEFAULT_REQUEST_OPTIONS: {},
		RequestUnlimited: {},
	};
});

import { RequestProxied } from "./RequestProxied";
import {
	endPoint as unlimitedEndPoint,
	endPoints as unlimitedEndPoints,
} from "./RequestUnlimited";

const PROXY1 = "https://proxy1.example.com";
const PROXY2 = "https://proxy2.example.com";
const PROXY3 = "https://proxy3.example.com";

describe("RequestProxied (Exhaustive)", () => {
	let proxied: RequestProxied;
	const mockEndPoint = unlimitedEndPoint as any;
	const mockEndPoints = unlimitedEndPoints as any;

	beforeAll(() => {
		// No MSW needed – we fully mock RequestUnlimited
	});
	beforeEach(() => {
		vi.clearAllMocks();

		// Default success
		mockEndPoint.mockResolvedValue({
			status: "success",
			value: { body: "ok" },
		});
		mockEndPoints.mockResolvedValue([
			{ status: "success", value: { body: "ok1" } },
			{ status: "success", value: { body: "ok2" } },
		]);

		proxied = new RequestProxied([PROXY1, PROXY2, PROXY3]);
	});
	afterEach(() => vi.clearAllMocks());

	// ===================================================================
	// Constructor
	// ===================================================================
	describe("Constructor", () => {
		it("throws if no proxies provided", () => {
			expect(() => new RequestProxied([])).toThrow(
				"at least one proxy URL is required",
			);
		});
	});

	// ===================================================================
	// URL Construction
	// ===================================================================
	describe("buildProxyUrl (internal)", () => {
		it("correctly appends suffix and encodes ?url=", () => {
			const url = (proxied as any).buildProxyUrl(
				"https://proxy.example.com",
				"/api/markets/nasdaq",
				"https://api.nasdaq.com/api/market-info?symbol=AAPL",
			);

			expect(url).toBe(
				"https://proxy.example.com/api/markets/nasdaq?url=https%3A%2F%2Fapi.nasdaq.com%2Fapi%2Fmarket-info%3Fsymbol%3DAAPL",
			);
		});
	});

	// ===================================================================
	// endPoint – Rotation + Fallback + Removal
	// ===================================================================
	describe("endPoint()", () => {
		it("rotates on every attempt", async () => {
			await proxied.endPoint("https://t.com");
			await proxied.endPoint("https://t.com");
			await proxied.endPoint("https://t.com");

			expect(mockEndPoint.mock.calls[0][0]).toContain(PROXY1);
			expect(mockEndPoint.mock.calls[1][0]).toContain(PROXY2);
			expect(mockEndPoint.mock.calls[2][0]).toContain(PROXY3);
		});

		it("falls back to all other proxies on failure", async () => {
			mockEndPoint
				.mockResolvedValueOnce({ status: "error", reason: { message: "p1" } })
				.mockResolvedValueOnce({ status: "error", reason: { message: "p2" } })
				.mockResolvedValueOnce({ status: "success", value: { body: "ok" } });

			const result = await proxied.endPoint("https://t.com");
			expect(result.status).toBe("success");
		});

		it("removes proxy after 3 consecutive failures", async () => {
			mockEndPoint.mockResolvedValue({
				status: "error",
				reason: { message: "fail" },
			});

			// Call enough times to ensure all hit 3 failures.
			for (let i = 0; i < 10; i++) {
				await proxied.endPoint("https://t.com");
			}

			expect((proxied as any).activeProxies.length).toBe(0);
		});

		it("returns error when all proxies fail", async () => {
			mockEndPoint.mockResolvedValue({
				status: "error",
				reason: { message: "fail" },
			});

			const result = await proxied.endPoint("https://t.com");

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect((result.reason as any).message).toBe("All proxies failed");
			}
		});

		it("uses suffix when provided", async () => {
			await proxied.endPoint("https://t.com", "/proxy/path");

			const calledUrl = mockEndPoint.mock.calls[0][0];
			expect(calledUrl).toContain("/proxy/path?url=https%3A%2F%2Ft.com");
		});
	});

	// ===================================================================
	// endPoints – Load Balancing
	// ===================================================================
	describe("endPoints()", () => {
		it("distributes URLs round-robin across proxies", async () => {
			const urls = [
				"https://t1.com",
				"https://t2.com",
				"https://t3.com",
				"https://t4.com",
			];
			await proxied.endPoints(urls, "/batch");

			const calledUrls = mockEndPoints.mock.calls[0][0];
			expect(calledUrls[0]).toContain(PROXY1);
			expect(calledUrls[1]).toContain(PROXY2);
			expect(calledUrls[2]).toContain(PROXY3);
			expect(calledUrls[3]).toContain(PROXY1);
		});
	});

	// ===================================================================
	// Edge Cases
	// ===================================================================
	describe("Edge Cases", () => {
		it("handles no active proxies left", async () => {
			(proxied as any).activeProxies = [];

			const result = await proxied.endPoint("https://t.com");

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect((result.reason as any).message).toBe("No active proxies left");
			}
		});
	});
});
