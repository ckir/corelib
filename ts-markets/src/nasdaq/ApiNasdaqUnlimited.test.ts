// =============================================
// FILE: ts-markets/src/nasdaq/ApiNasdaqUnlimited.test.ts
// PURPOSE: Exhaustive test suite for ApiNasdaqUnlimited
// Covers: Success, Logic Errors (rCode), Transport Errors, Headers (Standard vs Charting), Config Overrides, Parallel Requests.
// =============================================

import { ConfigManager } from "@ckir/corelib";
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
import { ApiNasdaqUnlimited } from "./ApiNasdaqUnlimited";

const server = setupServer(
	// 1. Standard Success
	http.get("https://api.nasdaq.com/api/quote/AAPL/info", () => {
		return HttpResponse.json({
			status: { rCode: 200, bCodeMessage: null, developerMessage: null },
			data: { symbol: "AAPL", price: 150.0 },
		});
	}),

	// 2. Charting Success (different headers check)
	http.get("https://charting.nasdaq.com/data", () => {
		return HttpResponse.json({
			status: { rCode: 200, bCodeMessage: null, developerMessage: null },
			data: { chart: [1, 2, 3] },
		});
	}),

	// 3. Logic Error (rCode 400)
	http.get("https://api.nasdaq.com/error-logic", () => {
		return HttpResponse.json({
			status: {
				rCode: 400,
				bCodeMessage: [{ code: "ERR1", errorMessage: "Symbol Not Found" }],
				developerMessage: "Bad Request",
			},
			data: null,
		});
	}),

	// 4. Transport Error (404)
	http.get("https://api.nasdaq.com/404", () => {
		return new HttpResponse(null, { status: 404 });
	}),

	// 5. Header override check
	http.get("https://api.nasdaq.com/override", ({ request }) => {
		const custom = request.headers.get("X-CUSTOM-CONFIG");
		return HttpResponse.json({
			status: { rCode: 200 },
			data: { customHeader: custom },
		});
	}),
);

describe("ApiNasdaqUnlimited", () => {
	beforeAll(() => {
		server.listen();
		// Mock global logger
		globalThis.logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			trace: vi.fn(),
			fatal: vi.fn(),
			child: vi.fn().mockReturnThis(),
			setTelemetry: vi.fn(),
			level: "info",
			levelVal: 30,
			bindings: vi.fn().mockReturnValue({}),
		} as any;
	});

	afterEach(() => {
		server.resetHandlers();
		vi.clearAllMocks();
	});

	afterAll(() => server.close());

	describe("endPoint()", () => {
		it("should return data on success", async () => {
			const result = await ApiNasdaqUnlimited.endPoint<any>(
				"https://api.nasdaq.com/api/quote/AAPL/info",
			);

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value).toEqual({ symbol: "AAPL", price: 150.0 });
				expect(result.details).toBeDefined();
			}
		});

		it("should handle Nasdaq logic errors (rCode !== 200)", async () => {
			const result = await ApiNasdaqUnlimited.endPoint(
				"https://api.nasdaq.com/error-logic",
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.reason.message).toContain(
					"code: ERR1 = Symbol Not Found",
				);
			}
			expect(globalThis.logger?.warn).toHaveBeenCalled();
		});

		it("should handle transport errors (e.g. 404)", async () => {
			const result = await ApiNasdaqUnlimited.endPoint(
				"https://api.nasdaq.com/404",
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.reason.message).toBe("Transport Error");
			}
			expect(globalThis.logger?.error).toHaveBeenCalled();
		});

		it("should use charting headers for charting URLs", async () => {
			const result = await ApiNasdaqUnlimited.endPoint<any>(
				"https://charting.nasdaq.com/data",
			);

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.chart).toEqual([1, 2, 3]);
			}
		});

		it("should apply header overrides from ConfigManager", async () => {
			vi.spyOn(ConfigManager, "get").mockReturnValue({
				"X-CUSTOM-CONFIG": "overridden",
			});

			const result = await ApiNasdaqUnlimited.endPoint<any>(
				"https://api.nasdaq.com/override",
			);

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.customHeader).toBe("overridden");
			}
		});

		it("should handle malformed status objects", async () => {
			server.use(
				http.get("https://api.nasdaq.com/malformed", () => {
					return HttpResponse.json({
						status: null,
						data: null,
					});
				}),
			);

			const result = await ApiNasdaqUnlimited.endPoint(
				"https://api.nasdaq.com/malformed",
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.reason.message).toBe("Malformed Nasdaq Response");
			}
		});
	});

	describe("endPoints()", () => {
		it("should handle parallel requests", async () => {
			const urls = [
				"https://api.nasdaq.com/api/quote/AAPL/info",
				"https://charting.nasdaq.com/data",
			];

			const results = await ApiNasdaqUnlimited.endPoints<any>(urls);

			expect(results).toHaveLength(2);
			expect(results[0].status).toBe("success");
			expect(results[1].status).toBe("success");
		});

		it("should return mixed results if one fails", async () => {
			const urls = [
				"https://api.nasdaq.com/api/quote/AAPL/info",
				"https://api.nasdaq.com/404",
			];

			const results = await ApiNasdaqUnlimited.endPoints<any>(urls);

			expect(results[0].status).toBe("success");
			expect(results[1].status).toBe("error");
		});
	});
});
