// =============================================
// FILE: ts-markets/src/nasdaq/ApiNasdaqQuotes.test.ts
// PURPOSE: Exhaustive test suite for ApiNasdaqQuotes
// Covers: Constructor, Symbol resolution, Proxied vs Direct strategies, Concurrency limiting, Error handling.
// =============================================

import { sleep } from "@ckir/corelib";
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
import { ApiNasdaqQuotes } from "./ApiNasdaqQuotes";
import { ApiNasdaqUnlimited } from "./ApiNasdaqUnlimited";
import { MarketSymbols } from "./MarketSymbols";

// Mock MarketSymbols
vi.mock("./MarketSymbols", () => {
	return {
		MarketSymbols: class {
			get = vi.fn();
			close = vi.fn();
		},
	};
});

// Mock RequestProxied
vi.mock("@ckir/corelib", async (importOriginal) => {
	const original = (await importOriginal()) as any;
	return {
		...original,
		RequestProxied: class {
			endPoints = vi.fn();
		},
	};
});

const server = setupServer(
	// Catch-all for Nasdaq API info requests
	http.get(/https:\/\/api\.nasdaq\.com\/api\/quote\/.*\/info/, () => {
		return HttpResponse.json({
			status: { rCode: 200, bCodeMessage: null, developerMessage: null },
			data: { symbol: "MOCK", price: 100.0 },
		});
	}),
);

describe("ApiNasdaqQuotes", () => {
	beforeAll(() => {
		server.listen({ onUnhandledRequest: "bypass" });
		// Mock global logger
		globalThis.logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			trace: vi.fn(),
			child: vi.fn().mockReturnThis(),
		} as any;
	});

	afterEach(() => {
		server.resetHandlers();
		vi.clearAllMocks();
	});

	afterAll(() => server.close());

	describe("Constructor", () => {
		it("should use provided MarketSymbols and Logger", () => {
			const mockSymbols = new MarketSymbols() as any;
			const mockLogger = { warn: vi.fn() } as any;
			const api = new ApiNasdaqQuotes({
				marketSymbols: mockSymbols,
				logger: mockLogger,
			});

			expect((api as any).marketSymbols).toBe(mockSymbols);
			expect((api as any).logger).toBe(mockLogger);
		});

		it("should initialize RequestProxied if proxies are provided", () => {
			const api = new ApiNasdaqQuotes({
				proxies: ["https://proxy1.com"],
			});

			expect((api as any).requestProxied).toBeDefined();
		});

		it("should fallback to global logger if none provided", () => {
			const api = new ApiNasdaqQuotes();
			expect((api as any).logger).toBe(globalThis.logger);
		});
	});

	describe("getNasdaqQuote() - Direct Strategy", () => {
		it("should fetch quotes for valid symbols using ApiNasdaqUnlimited", async () => {
			const mockSymbols = new MarketSymbols() as any;
			mockSymbols.get.mockImplementation(async (sym: string) => {
				if (sym === "AAPL") return { symbol: "AAPL", class: "stocks" };
				if (sym === "MSFT") return { symbol: "MSFT", class: "stocks" };
				return null;
			});

			const api = new ApiNasdaqQuotes({ marketSymbols: mockSymbols });
			const results = await api.getNasdaqQuote(["AAPL", "MSFT"]);

			expect(results).toHaveLength(2);
			expect(results[0].status).toBe("success");
			expect(results[1].status).toBe("success");
		});

		it("should return empty array for empty input", async () => {
			const api = new ApiNasdaqQuotes();
			const results = await api.getNasdaqQuote([]);
			expect(results).toEqual([]);
		});

		it("should return error status for unknown symbols", async () => {
			const mockSymbols = new MarketSymbols() as any;
			mockSymbols.get.mockResolvedValue(null);

			const api = new ApiNasdaqQuotes({ marketSymbols: mockSymbols });
			const results = await api.getNasdaqQuote(["UNKNOWN"]);

			expect(results).toHaveLength(1);
			expect(results[0].status).toBe("error");
			expect((results[0] as any).reason.message).toContain("not found");
		});

		it("should respect concurrencyLimit and process in batches", async () => {
			const mockSymbols = new MarketSymbols() as any;
			mockSymbols.get.mockResolvedValue({ symbol: "AAPL", class: "stocks" });

			let activeRequests = 0;
			let maxActiveRequests = 0;

			const spy = vi
				.spyOn(ApiNasdaqUnlimited, "endPoint")
				.mockImplementation(async () => {
					activeRequests++;
					maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
					await sleep(50);
					activeRequests--;
					return { status: "success", value: {} } as any;
				});

			const api = new ApiNasdaqQuotes({
				marketSymbols: mockSymbols,
				concurrencyLimit: 2,
			});

			// Fetch 5 quotes. Batching: [S1, S2] -> [S3, S4] -> [S5]
			await api.getNasdaqQuote(["S1", "S2", "S3", "S4", "S5"]);

			expect(spy).toHaveBeenCalledTimes(5);
			expect(maxActiveRequests).toBeLessThanOrEqual(2);
			spy.mockRestore();
		});

		it("should handle unexpected errors during symbol resolution", async () => {
			const mockSymbols = new MarketSymbols() as any;
			mockSymbols.get.mockRejectedValue(new Error("DB Down"));

			const api = new ApiNasdaqQuotes({ marketSymbols: mockSymbols });
			const results = await api.getNasdaqQuote(["AAPL"]);

			expect(results[0].status).toBe("error");
			expect((results[0] as any).reason.message).toContain("DB Down");
		});

		it("should handle ApiNasdaqUnlimited errors", async () => {
			const mockSymbols = new MarketSymbols() as any;
			mockSymbols.get.mockResolvedValue({ symbol: "AAPL", class: "stocks" });

			const api = new ApiNasdaqQuotes({ marketSymbols: mockSymbols });
			const spy = vi.spyOn(ApiNasdaqUnlimited, "endPoint").mockResolvedValue({
				status: "error",
				reason: { message: "Mocked Transport Error" },
			});

			const results = await api.getNasdaqQuote(["AAPL"]);

			expect(results[0].status).toBe("error");
			expect((results[0] as any).reason.message).toBe("Mocked Transport Error");
			spy.mockRestore();
		});
	});

	describe("getNasdaqQuote() - Proxied Strategy", () => {
		it("should use RequestProxied.endPoints for bulk fetching", async () => {
			const mockSymbols = new MarketSymbols() as any;
			mockSymbols.get.mockResolvedValue({ symbol: "AAPL", class: "stocks" });

			const api = new ApiNasdaqQuotes({
				marketSymbols: mockSymbols,
				proxies: ["https://proxy1.com"],
			});

			const mockProxied = (api as any).requestProxied;
			mockProxied.endPoints.mockResolvedValue([
				{
					status: "success",
					value: {
						status: 200,
						body: {
							status: { rCode: 200 },
							data: { symbol: "AAPL", price: 150 },
						},
					},
				},
			]);

			const results = await api.getNasdaqQuote(["AAPL"]);

			expect(results[0].status).toBe("success");
			expect((results[0] as any).value.symbol).toBe("AAPL");
			expect(mockProxied.endPoints).toHaveBeenCalled();
		});

		it("should handle proxy level errors", async () => {
			const mockSymbols = new MarketSymbols() as any;
			mockSymbols.get.mockResolvedValue({ symbol: "AAPL", class: "stocks" });

			const api = new ApiNasdaqQuotes({
				marketSymbols: mockSymbols,
				proxies: ["https://proxy1.com"],
			});

			const mockProxied = (api as any).requestProxied;
			mockProxied.endPoints.mockResolvedValue([
				{
					status: "error",
					reason: { message: "Proxy Timeout" },
				},
			]);

			const results = await api.getNasdaqQuote(["AAPL"]);

			expect(results[0].status).toBe("error");
			expect((results[0] as any).reason.message).toBe("Proxy Timeout");
		});

		it("should handle Nasdaq logic errors via proxy", async () => {
			const mockSymbols = new MarketSymbols() as any;
			mockSymbols.get.mockResolvedValue({ symbol: "AAPL", class: "stocks" });

			const api = new ApiNasdaqQuotes({
				marketSymbols: mockSymbols,
				proxies: ["https://proxy1.com"],
			});

			const mockProxied = (api as any).requestProxied;
			mockProxied.endPoints.mockResolvedValue([
				{
					status: "success",
					value: {
						status: 200,
						body: {
							status: { rCode: 400, developerMessage: "Invalid Symbol" },
							data: null,
						},
					},
				},
			]);

			const results = await api.getNasdaqQuote(["AAPL"]);

			expect(results[0].status).toBe("error");
			expect((results[0] as any).reason.message).toBe("Invalid Symbol");
		});
	});

	describe("close()", () => {
		it("should close internal MarketSymbols", async () => {
			const api = new ApiNasdaqQuotes();
			const internalSymbols = (api as any).marketSymbols;
			await api.close();
			expect(internalSymbols.close).toHaveBeenCalled();
		});

		it("should NOT close external MarketSymbols", async () => {
			const extSymbols = new MarketSymbols() as any;
			const api = new ApiNasdaqQuotes({ marketSymbols: extSymbols });
			await api.close();
			expect(extSymbols.close).not.toHaveBeenCalled();
		});
	});
});
