/**
 * @module Nasdaq/Groups/Top100
 * @description Provides access to the Nasdaq 100 constituent symbols with in-memory caching and request collapsing.
 */

import { logger } from "@ckir/corelib";
import { ApiNasdaqUnlimited } from "../ApiNasdaqUnlimited";

// ---------------------------------------------------------------------------
// Local Type Definitions
// ---------------------------------------------------------------------------

/**
 * Represents a single stock row in the Nasdaq 100 list.
 */
interface Nasdaq100Row {
	symbol: string;
	sector: string;
	companyName: string;
	marketCap: string;
	lastSalePrice: string;
	netChange: string;
	percentageChange: string;
	deltaIndicator: string;
}

/**
 * Internal structure of the Nasdaq 100 API response payload.
 */
interface Nasdaq100ResponseData {
	totalrecords: number;
	limit: number;
	offset: number;
	date: string;
	data: {
		asOf: string | null;
		headers: Record<string, string>;
		rows: Nasdaq100Row[];
	};
	filters: unknown | null;
	title: string | null;
}

// ---------------------------------------------------------------------------
// Private Module State
// ---------------------------------------------------------------------------

/**
 * In-memory cache for the symbols, persisting for the lifetime of the process.
 */
let cachedSymbols: string[] | null = null;

/**
 * Stores the active request promise to collapse concurrent calls (Thundering Herd protection).
 */
let activeFetchPromise: Promise<string[]> | null = null;

// ---------------------------------------------------------------------------
// Public Functions
// ---------------------------------------------------------------------------

/**
 * Retrieves the list of Nasdaq 100 symbols, sorted alphabetically.
 *
 * @remarks
 * - If the data is already cached, it returns the cached list immediately.
 * - If a request is already in progress, it returns the existing promise.
 * - In case of failure or empty data, it logs a warning via StrictLogger and returns an empty array.
 *
 * @returns A Promise resolving to an array of ticker symbols (e.g., ["AAPL", "AMZN", ...]).
 */
export async function getSymbolsTop100(): Promise<string[]> {
	// 1. Check if we have a valid cache
	if (cachedSymbols !== null) {
		return cachedSymbols;
	}

	// 2. Collapse concurrent requests
	if (activeFetchPromise !== null) {
		return activeFetchPromise;
	}

	// 3. Initiate the request
	activeFetchPromise = (async () => {
		try {
			const url = "https://api.nasdaq.com/api/quote/list-type/nasdaq100";
			const response =
				await ApiNasdaqUnlimited.endPoint<Nasdaq100ResponseData>(url);

			// Handle API-level errors
			if (response.status === "error") {
				logger?.warn("Failed to fetch Nasdaq 100 symbols via API", {
					reason: response.reason,
				});
				return [];
			}

			const rows = response.value?.data?.rows;

			// Handle empty or malformed data
			if (!Array.isArray(rows) || rows.length === 0) {
				logger?.warn("Nasdaq 100 API returned an empty or invalid dataset", {
					payload: response.value,
				});
				return [];
			}

			// Extract symbols and perform standard alphabetical sort (A-Z)
			const symbols = rows
				.map((row) => row.symbol)
				.sort((a, b) => a.localeCompare(b));

			// Update persistent cache
			cachedSymbols = symbols;

			return symbols;
		} catch (error) {
			// Handle unexpected runtime errors (network timeouts, etc.)
			logger?.warn("Unexpected error in Top100 module", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		} finally {
			// Clear the active promise so that subsequent calls (if cache were to be cleared) can retry
			activeFetchPromise = null;
		}
	})();

	return activeFetchPromise;
}
