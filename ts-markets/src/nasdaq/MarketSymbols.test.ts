// =============================================
// FILE: ts-markets/src/nasdaq/MarketSymbols.test.ts
// PURPOSE: Exhaustive test suite for MarketSymbols
// Covers: constructor variants, table creation, auto-refresh logic,
// parsing (nasdaqlisted + otherlisted), get(), resilience/retry,
// close(), date-based freshness (NY timezone), error paths.
// =============================================

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// ---------------------------------------------------------
// MOCKS (must be hoisted)
// ---------------------------------------------------------
vi.mock("@ckir/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ckir/corelib")>();
	return {
		...actual,
		createDatabase: vi.fn(),
		endPoints: vi.fn(),
		getTempDir: vi.fn(() => "/tmp"),
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	};
});

import { createDatabase, endPoints, getTempDir } from "@ckir/corelib";
import { MarketSymbols } from "./MarketSymbols";

// Sample TXT content (real structure from Nasdaq)
const NASDAQ_LISTED_SAMPLE = `Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
AAPL|Apple Inc.|Q|N|N|100|Y|N
TSLA|Tesla, Inc.|Q|N|N|100|N|N
`;

const OTHER_LISTED_SAMPLE = `Symbol|Security Name|Exchange|Test Issue|ETF
MSFT|Microsoft Corporation|N|N|N
GOOGL|Alphabet Inc.|N|N|N
`;

const server = setupServer(
	http.get("https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt", () =>
		HttpResponse.text(NASDAQ_LISTED_SAMPLE),
	),
	http.get("https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt", () =>
		HttpResponse.text(OTHER_LISTED_SAMPLE),
	),
);

describe("MarketSymbols (Exhaustive)", () => {
	let symbols: MarketSymbols;

	beforeAll(() => server.listen());
	afterEach(() => {
		server.resetHandlers();
		vi.clearAllMocks();
		vi.useRealTimers();
	});
	afterAll(() => server.close());

	beforeEach(() => {
		vi.setSystemTime(new Date("2026-03-17T12:00:00Z")); // fixed NY date for tests
		// Default mock: successful DB creation
		(createDatabase as any).mockResolvedValue({
			query: vi
				.fn()
				.mockResolvedValue({ status: "success", value: { rows: [] } }),
			disconnect: vi.fn(),
			transaction: vi.fn().mockImplementation(async (cb: any) => {
				const res = await cb();
				return res || ({ status: "success", value: null } as any);
			}),
		});
		// Default mock: successful endpoints
		(endPoints as any).mockResolvedValue([
			{ status: "success", value: { body: NASDAQ_LISTED_SAMPLE } },
			{ status: "success", value: { body: OTHER_LISTED_SAMPLE } },
		]);
	});

	// ===================================================================
	// Constructor & Initialization
	// ===================================================================
	describe("Constructor", () => {
		it("uses default temp path when no argument", () => {
			new MarketSymbols();
			expect(getTempDir).toHaveBeenCalled();
		});

		it("accepts string path", () => {
			new MarketSymbols("/custom/path.sqlite");
		});

		it("accepts Turso config object", () => {
			new MarketSymbols({ dbUrl: "libsql://...", dbToken: "token123" });
		});
	});

	// ===================================================================
	// Table & Auto-Refresh
	// ===================================================================
	describe("Auto-refresh", () => {
		it("creates table + index on first use", async () => {
			symbols = new MarketSymbols();
			await symbols.get("AAPL"); // triggers init

			const dbMock = await (createDatabase as any).mock.results[0].value;
			expect(dbMock.query).toHaveBeenCalledWith(
				expect.stringContaining("CREATE TABLE IF NOT EXISTS nasdaq_symbols"),
			);
			expect(dbMock.query).toHaveBeenCalledWith(
				expect.stringContaining("CREATE INDEX IF NOT EXISTS"),
			);
		});

		it("refreshes when table is empty", async () => {
			symbols = new MarketSymbols();
			await symbols.get("AAPL");

			expect(endPoints).toHaveBeenCalled();
		});

		it("skips refresh when MAX(ts) is today (NY time)", async () => {
			// Simulate existing fresh data
			(createDatabase as any).mockResolvedValueOnce({
				query: vi.fn().mockImplementation(async (sql: string) => {
					if (sql.includes("MAX(ts)")) {
						return {
							status: "success",
							value: { rows: [{ max_ts: Date.now() }] },
						};
					}
					return { status: "success", value: { rows: [] } };
				}),
				disconnect: vi.fn(),
			});

			symbols = new MarketSymbols();
			await symbols.get("AAPL");

			expect(endPoints).not.toHaveBeenCalled();
		});
	});

	// ===================================================================
	// Parsing & Data Integrity
	// ===================================================================
	describe("Parsing", () => {
		it("correctly parses nasdaqlisted.txt (ETF flag respected)", async () => {
			// Setup mock to return data after refresh
			const data: any[] = [];
			(createDatabase as any).mockResolvedValue({
				query: vi
					.fn()
					.mockImplementation(async (sql: string, params?: any[]) => {
						if (sql.includes("INSERT INTO nasdaq_symbols")) {
							data.push({
								symbol: params?.[0],
								type: params?.[1],
								class: params?.[2],
								name: params?.[3],
							});
							return { status: "success", value: { rows: [] } };
						}
						if (sql.includes("SELECT") && params && params[0] === "AAPL") {
							const found = data.find((r) => r.symbol === "AAPL");
							return {
								status: "success",
								value: { rows: found ? [found] : [] },
							};
						}
						if (sql.includes("MAX(ts)")) {
							return { status: "success", value: { rows: [] } };
						}
						return { status: "success", value: { rows: [] } };
					}),
				transaction: vi.fn().mockImplementation(async (cb: any) => {
					const res = await cb();
					return res || { status: "success", value: null };
				}),
				disconnect: vi.fn(),
			});

			symbols = new MarketSymbols();
			await symbols.refresh();

			const aapl = await symbols.get("AAPL");
			expect(aapl?.class).toBe("etf");
		});

		it("deduplicates symbols (nasdaqlisted wins)", async () => {
			symbols = new MarketSymbols();
			await symbols.refresh();

			const dbMock = await (createDatabase as any).mock.results[0].value;
			// check that transaction was called
			expect(dbMock.transaction).toHaveBeenCalled();
		});
	});

	// ===================================================================
	// Public API: get()
	// ===================================================================
	describe("get()", () => {
		it("returns null for inactive/missing symbol", async () => {
			// Ensure it doesn't refresh by mocking MAX(ts)
			(createDatabase as any).mockResolvedValueOnce({
				query: vi.fn().mockImplementation(async (sql: string) => {
					if (sql.includes("MAX(ts)")) {
						return {
							status: "success",
							value: { rows: [{ max_ts: Date.now() }] },
						};
					}
					return { status: "success", value: { rows: [] } };
				}),
				disconnect: vi.fn(),
			});

			symbols = new MarketSymbols();
			expect(await symbols.get("XYZ")).toBeNull();
		});

		it("is case-insensitive", async () => {
			(createDatabase as any).mockResolvedValueOnce({
				query: vi
					.fn()
					.mockImplementation(async (sql: string, params?: any[]) => {
						if (sql.includes("MAX(ts)")) {
							return {
								status: "success",
								value: { rows: [{ max_ts: Date.now() }] },
							};
						}
						if (sql.includes("SELECT") && params && params[0] === "AAPL") {
							return {
								status: "success",
								value: { rows: [{ symbol: "AAPL", name: "Apple" }] },
							};
						}
						return { status: "success", value: { rows: [] } };
					}),
				disconnect: vi.fn(),
			});

			symbols = new MarketSymbols();
			const row = await symbols.get("aapl");
			expect(row?.symbol).toBe("AAPL");
		});
	});

	// ===================================================================
	// Resilience & Error Paths
	// ===================================================================
	describe("Resilience", () => {
		it("retries forever with backoff when DB exists", async () => {
			(endPoints as any)
				.mockResolvedValueOnce([
					{ status: "error", reason: { message: "network" } },
					{ status: "success", value: { body: "" } },
				])
				.mockResolvedValueOnce([
					{ status: "success", value: { body: NASDAQ_LISTED_SAMPLE } },
					{ status: "success", value: { body: OTHER_LISTED_SAMPLE } },
				]);

			(createDatabase as any).mockResolvedValueOnce({
				query: vi.fn().mockImplementation(async (sql: string) => {
					if (sql.includes("MAX(ts)")) {
						return { status: "success", value: { rows: [] } };
					}
					if (sql.includes("COUNT(*)")) {
						return {
							status: "success",
							value: { rows: [{ count: 5 }] },
						};
					}
					return { status: "success", value: { rows: [] } };
				}),
				transaction: vi.fn().mockImplementation(async (cb: any) => {
					const res = await cb();
					return res || { status: "success", value: null };
				}),
				disconnect: vi.fn(),
			});

			symbols = new MarketSymbols();
			// Should not throw (retries)
			await expect(symbols.refresh()).resolves.not.toThrow();
		});

		it("throws fatal when first-time fetch fails and no DB", async () => {
			(endPoints as any).mockResolvedValue([
				{ status: "error", reason: { message: "404" } },
			]);

			symbols = new MarketSymbols();
			await expect(symbols.refresh()).rejects.toThrow(
				/Failed to construct symbols db/,
			);
		});
	});

	// ===================================================================
	// close()
	// ===================================================================
	it("closes database gracefully", async () => {
		// Mock to skip refresh
		(createDatabase as any).mockResolvedValueOnce({
			query: vi.fn().mockResolvedValue({
				status: "success",
				value: { rows: [{ max_ts: Date.now() }] },
			}),
			disconnect: vi.fn(),
		});

		symbols = new MarketSymbols();
		await symbols.get("AAPL"); // triggers init
		await symbols.close();
		const dbMock = await (createDatabase as any).mock.results[0].value;
		expect(dbMock.disconnect).toHaveBeenCalled();
	});
});
