/**
 * @file Top100.test.ts
 * @description Exhaustive test suite for the Top100 module.
 * Covers A-Z sorting, in-memory caching, thundering herd protection, and error handling.
 */

import { logger } from "@ckirg/corelib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Fixed relative path: Top100.test.ts is in 'groups/', ApiNasdaqUnlimited is in '../'
import { ApiNasdaqUnlimited } from "../ApiNasdaqUnlimited";

// ---------------------------------------------------------------------------
// Mock Configuration
// ---------------------------------------------------------------------------

vi.mock("@ckirg/corelib", () => ({
	logger: {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	},
}));

// Fixed relative path for the mock to match the import
vi.mock("../ApiNasdaqUnlimited", () => ({
	ApiNasdaqUnlimited: {
		endPoint: vi.fn(),
	},
}));

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Top100 Module", () => {
	let getSymbolsTop100: () => Promise<string[]>;

	beforeEach(async () => {
		vi.clearAllMocks();

		// Reset module state to ensure 'cachedSymbols' and 'activeFetchPromise' are cleared
		vi.resetModules();
		// Fixed relative path: Top100.ts is in the same directory (./)
		const mod = await import("./Top100");
		getSymbolsTop100 = mod.getSymbolsTop100;
	});

	/**
	 * Utility to create a standardized successful API response.
	 */
	const mockSuccess = (symbols: string[]) => ({
		status: "success",
		value: {
			data: {
				rows: symbols.map((s) => ({ symbol: s })),
			},
		},
	});

	it("should return symbols sorted alphabetically (A-Z)", async () => {
		const rawData = ["ZBRA", "AAPL", "MSFT"];
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue(
			mockSuccess(rawData) as any,
		);

		const result = await getSymbolsTop100();

		expect(result).toEqual(["AAPL", "MSFT", "ZBRA"]);
		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledOnce();
		expect(logger.debug).toHaveBeenCalledWith(
			"top100: fetch",
			expect.objectContaining({ url: expect.any(String) }),
		);
		expect(logger.debug).toHaveBeenCalledWith(
			"top100: populated",
			expect.objectContaining({ count: 3 }),
		);
	});

	it("should return the cached result on subsequent calls without re-fetching", async () => {
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue(
			mockSuccess(["TSLA"]) as any,
		);

		const firstCall = await getSymbolsTop100();
		const secondCall = await getSymbolsTop100();

		expect(firstCall).toEqual(["TSLA"]);
		expect(secondCall).toBe(firstCall); // Verify referential equality (cache hit)
		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledTimes(1);
		expect(logger.debug).toHaveBeenCalledWith(
			"top100: cache hit",
			expect.objectContaining({ count: expect.any(Number) }),
		);
	});

	it("should collapse multiple concurrent calls into a single network request", async () => {
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockImplementation(
			() =>
				new Promise((resolve) =>
					setTimeout(() => resolve(mockSuccess(["NVDA"]) as any), 10),
				),
		);

		// Fire multiple requests simultaneously
		const results = await Promise.all([
			getSymbolsTop100(),
			getSymbolsTop100(),
			getSymbolsTop100(),
		]);

		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledTimes(1);
		for (const res of results) {
			expect(res).toEqual(["NVDA"]);
		}
	});

	it("should return an empty array and log a warning if the API returns an error status", async () => {
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue({
			status: "error",
			reason: "Forbidden",
		} as any);

		const result = await getSymbolsTop100();

		expect(result).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			"Failed to fetch Nasdaq 100 symbols via API",
			{ reason: "Forbidden" },
		);
	});

	it("should return an empty array and log a warning on malformed API data", async () => {
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue({
			status: "success",
			value: { data: { rows: null } }, // Invalid rows
		} as any);

		const result = await getSymbolsTop100();

		expect(result).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			"Nasdaq 100 API returned an empty or invalid dataset",
			expect.any(Object),
		);
	});

	it("should return an empty array and log a warning on an unhandled exception", async () => {
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockRejectedValue(
			new Error("DNS Failure"),
		);

		const result = await getSymbolsTop100();

		expect(result).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			"Unexpected error in Top100 module",
			{ error: "DNS Failure" },
		);
	});

	it("should allow a retry if the previous attempt failed", async () => {
		// Mock a failure then a success
		vi.mocked(ApiNasdaqUnlimited.endPoint)
			.mockRejectedValueOnce(new Error("First Failure"))
			.mockResolvedValueOnce(mockSuccess(["AMD"]) as any);

		const firstResult = await getSymbolsTop100();
		expect(firstResult).toEqual([]);

		const secondResult = await getSymbolsTop100();
		expect(secondResult).toEqual(["AMD"]);
		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledTimes(2);
	});
});

describe("Top100 TTL and deterministic sort", () => {
	let getSymbolsTop100: () => Promise<string[]>;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.resetModules();
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockReset();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		getSymbolsTop100 = (await import("./Top100")).getSymbolsTop100;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const ok = (symbols: string[]) =>
		({
			status: "success",
			value: { data: { rows: symbols.map((symbol) => ({ symbol })) } },
		}) as never;

	it("serves the cache within the 1 hour TTL and refetches after it", async () => {
		vi.mocked(ApiNasdaqUnlimited.endPoint)
			.mockResolvedValueOnce(ok(["AAPL"]))
			.mockResolvedValueOnce(ok(["MSFT"]));

		expect(await getSymbolsTop100()).toEqual(["AAPL"]);
		vi.setSystemTime(new Date("2026-01-01T00:59:59Z"));
		expect(await getSymbolsTop100()).toEqual(["AAPL"]);
		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledTimes(1);

		vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
		expect(await getSymbolsTop100()).toEqual(["MSFT"]);
		expect(ApiNasdaqUnlimited.endPoint).toHaveBeenCalledTimes(2);
	});

	it("sorts by code unit, independent of locale", async () => {
		vi.mocked(ApiNasdaqUnlimited.endPoint).mockResolvedValue(
			ok(["b", "A", "a", "B", "BRKB", "BRK.B"]),
		);
		expect(await getSymbolsTop100()).toEqual([
			"A",
			"B",
			"BRK.B",
			"BRKB",
			"a",
			"b",
		]);
	});
});
