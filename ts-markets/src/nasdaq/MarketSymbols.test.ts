// =============================================
// FILE: ts-markets/src/nasdaq/MarketSymbols.test.ts
// =============================================

import * as corelib from "@ckir/corelib";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiNasdaqUnlimited } from "./ApiNasdaqUnlimited";
import { MarketSymbols } from "./MarketSymbols";

// ---------------------------------------------------------------------------
// 1. Mock External Dependencies
// ---------------------------------------------------------------------------
vi.mock("@ckir/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof corelib>();
	return {
		...actual,
		detectRuntime: vi.fn(),
		endPoint: vi.fn(),
		endPoints: vi.fn(),
		createDatabase: vi.fn(),
		getTempDir: vi.fn(() => "/tmp"),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		sleep: vi.fn(),
	};
});

vi.mock("./ApiNasdaqUnlimited", () => ({
	ApiNasdaqUnlimited: {
		endPoint: vi.fn(),
	},
}));

describe("MarketSymbols - Integrated Suite", () => {
	let marketSymbols: MarketSymbols;
	const mockDbQuery = vi.fn();
	const mockDbTransaction = vi.fn();
	const mockDbDisconnect = vi.fn();

	const mockDb = {
		query: mockDbQuery,
		transaction: mockDbTransaction,
		disconnect: mockDbDisconnect,
	};

	const GAS_URL = "https://script.google.com/macros/s/TEST/exec";

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(corelib.createDatabase).mockResolvedValue(mockDb as any);
		vi.mocked(corelib.detectRuntime).mockReturnValue("node");

		// Default behavior: DB is fresh, no refresh needed
		mockDbQuery.mockImplementation((query: string) => {
			if (query.includes("SELECT MAX(ts)")) {
				return Promise.resolve({
					status: "success",
					value: { rows: [{ max_ts: Date.now() }] },
				});
			}
			return Promise.resolve({ status: "success", value: { rows: [] } });
		});

		marketSymbols = new MarketSymbols("/tmp/test.sqlite", [GAS_URL]);
	});

	afterEach(async () => {
		await marketSymbols.close();
	});

	// -----------------------------------------------------------------------
	// 2. Lifecycle & Internal Database Tests (From Original Version)
	// -----------------------------------------------------------------------
	describe("Internal Database Lifecycle", () => {
		it("should initialize tables and indexes on first query", async () => {
			await marketSymbols.get("AAPL");

			expect(mockDbQuery).toHaveBeenCalledWith(
				expect.stringContaining("CREATE TABLE IF NOT EXISTS nasdaq_symbols"),
			);
			expect(mockDbQuery).toHaveBeenCalledWith(
				expect.stringContaining(
					"CREATE INDEX IF NOT EXISTS idx_nasdaq_symbols_active",
				),
			);
		});

		it("should trigger a refresh if the database is empty", async () => {
			// Specifically mock MAX(ts) to return nothing for this test
			mockDbQuery.mockImplementation((query: string) => {
				if (query.includes("MAX(ts)")) {
					return Promise.resolve({
						status: "success",
						value: { rows: [] },
					});
				}
				return Promise.resolve({ status: "success", value: { rows: [] } });
			});

			vi.mocked(corelib.endPoints).mockResolvedValue([
				{
					status: "success",
					value: { body: "Symbol|Name|...|ETF|...\nAAPL|Apple|N\n" },
				},
				{
					status: "success",
					value: { body: "Symbol|Name|...|ETF|...\nMSFT|Microsoft|N\n" },
				},
			] as any);

			await marketSymbols.refresh();
			expect(corelib.endPoints).toHaveBeenCalled();
			expect(mockDbTransaction).toHaveBeenCalled();
		});

		it("should skip refresh if data was updated today (NY Time)", async () => {
			const todayNY = DateTime.now().setZone("America/New_York").toMillis();
			mockDbQuery.mockImplementation((query: string) => {
				if (query.includes("MAX(ts)")) {
					return Promise.resolve({
						status: "success",
						value: { rows: [{ max_ts: todayNY }] },
					});
				}
				return Promise.resolve({ status: "success", value: { rows: [] } });
			});

			await marketSymbols.refresh();
			expect(corelib.endPoints).not.toHaveBeenCalled();
		});

		it("should correctly parse Nasdaq directory text files", async () => {
			// Accessing private methods for unit testing parsing logic
			const nasdaqText =
				"Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\n" +
				"AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N\n" +
				"QQQ|Invesco QQQ Trust|Q|N|N|100|Y|N";

			// @ts-expect-error - access private for test
			const rows = marketSymbols.parseNasdaqListed(nasdaqText);

			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({
				symbol: "AAPL",
				class: "stocks",
				type: "rt",
			});
			expect(rows[1]).toMatchObject({
				symbol: "QQQ",
				class: "etf",
				type: "rt",
			});
		});

		it("should call disconnect when closing", async () => {
			await marketSymbols.get("AAPL"); // init
			await marketSymbols.close();
			expect(mockDbDisconnect).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// 3. Environment-Aware Search Sequence (The New Functionality)
	// -----------------------------------------------------------------------
	describe("Search Sequencing", () => {
		it("NodeJS: Sequence should be DB -> API -> Ingestor", async () => {
			vi.mocked(corelib.detectRuntime).mockReturnValue("node");

			// 1. DB returns null
			mockDbQuery.mockResolvedValue({ status: "success", value: { rows: [] } });
			// 2. API returns AAPL
			vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue({
				status: "success",
				value: [{ symbol: "AAPL", name: "Apple", asset: "STOCKS" }],
			} as any);

			const result = await marketSymbols.get("AAPL");

			expect(mockDbQuery).toHaveBeenCalledWith(
				expect.stringContaining("SELECT symbol"),
				["AAPL"],
			);
			expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalled();
			expect(corelib.endPoint).not.toHaveBeenCalled(); // Ingestor not reached
			expect(result?.name).toBe("Apple");
		});

		it("Edge: Sequence should be API -> Ingestor -> DB", async () => {
			vi.mocked(corelib.detectRuntime).mockReturnValue("cloudflare");

			// 1. API fails
			vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue({
				status: "error",
			} as any);
			// 2. Ingestor succeeds
			vi.mocked(corelib.endPoint).mockResolvedValue({
				status: "success",
				value: {
					body: {
						status: "success",
						value: { symbol: "AAPL", name: "Edge Name" },
					},
				},
			} as any);

			const result = await marketSymbols.get("AAPL");

			expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalled();
			expect(corelib.endPoint).toHaveBeenCalledWith(
				expect.stringContaining(GAS_URL),
			);

			// DB check for the actual symbol search should not have happened
			// because Ingestor succeeded.
			// Initialization queries (CREATE TABLE, CREATE INDEX, SELECT MAX(ts)) are expected.
			const symbolSearchCalls = mockDbQuery.mock.calls.filter(
				(call) =>
					typeof call[0] === "string" &&
					call[0].includes("SELECT symbol, type") &&
					call[0].includes("FROM nasdaq_symbols"),
			);
			expect(symbolSearchCalls.length).toBe(0);

			expect(result?.name).toBe("Edge Name");
		});
	});

	// -----------------------------------------------------------------------
	// 4. Ingestor Implementation
	// -----------------------------------------------------------------------
	describe("Ingestors", () => {
		it("should ignore ingestor URLs that do not match a registry pattern", async () => {
			const customSymbols = new MarketSymbols("/tmp/test.sqlite", [
				"https://unknown-service.com/api",
			]);
			vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue({
				status: "error",
			} as any);

			await customSymbols.get("AAPL");
			expect(corelib.endPoint).not.toHaveBeenCalled(); // No pattern match, no fetch
		});

		it("should correctly handle GAS ingestor success and transform data", async () => {
			vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue({
				status: "error",
			} as any);
			vi.mocked(corelib.endPoint).mockResolvedValue({
				status: "success",
				value: {
					body: {
						status: "success",
						value: {
							symbol: "AAPL",
							type: "rt",
							class: "stocks",
							name: "GAS Store",
							active: true,
						},
					},
				},
			} as any);

			const result = await marketSymbols.get("AAPL");
			expect(result).toMatchObject({
				symbol: "AAPL",
				name: "GAS Store",
				type: "rt",
			});
		});
	});
});
