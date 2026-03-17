// =============================================
// FILE: ts-markets/src/nasdaq/MarketSymbols.ts
// PURPOSE: Persistent Nasdaq symbol database (SQLite or Turso).
// • Auto-creates table + indexes
// • Auto-refreshes from official Nasdaq symbol directories if empty or outdated
// • Uses MAX(ts) vs today (America/New_York) for freshness
// • nasdaqlisted.txt + otherlisted.txt → realtime symbols
// • Inactive symbols kept (active=false) for history
// • Resilient fetch (infinite retry with 1h cap backoff when DB exists)
// • Constructor: undefined (temp file), string (path), or {dbUrl, dbToken} (Turso)
// =============================================

import {
	createDatabase,
	type Database,
	type DatabaseResult,
	endPoints,
	getTempDir,
	logger,
	sleep,
} from "@ckir/corelib";
import { DateTime } from "luxon";
import { Realtime } from "./AssetClass";

const NASDAQ_LISTED_URL =
	"https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt";
const OTHER_LISTED_URL =
	"https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt";

export interface MarketSymbolRow {
	symbol: string;
	name: string;
	type: "rt" | "eod";
	class: string;
	ts: number;
	active: boolean;
}

/**
 * Nasdaq symbol database using ts-core SQLite (local or Turso).
 *
 * Automatically refreshes on first use or when data is older than today (NY time).
 * Uses the exact Database API from ts-core (QueryResponse has .rows, transaction must return DatabaseResult).
 */
export class MarketSymbols {
	private db: Database | null = null;
	private readonly config: {
		dialect: "sqlite";
		url: string;
		mode: "stateful" | "stateless";
		authToken?: string;
	};

	/**
	 * @param db - Optional database configuration:
	 *   - `undefined` → uses `${getTempDir()}/NasdaqSymbols.sqlite`
	 *   - `string` → local SQLite file path
	 *   - `{ dbUrl: string; dbToken: string }` → Turso/LibSQL remote
	 */
	constructor(db?: string | { dbUrl: string; dbToken: string }) {
		if (!db) {
			const path = `${getTempDir()}/NasdaqSymbols.sqlite`;
			this.config = {
				dialect: "sqlite",
				url: `file:${path}`,
				mode: "stateful",
			};
		} else if (typeof db === "string") {
			this.config = {
				dialect: "sqlite",
				url:
					db.startsWith("libsql://") || db.startsWith("file:")
						? db
						: `file:${db}`,
				mode: "stateful",
			};
		} else {
			this.config = {
				dialect: "sqlite",
				url: db.dbUrl,
				authToken: db.dbToken,
				mode: "stateful",
			};
		}
	}

	/**
	 * Force a full refresh of the symbol database.
	 * Called automatically on first use if needed.
	 */
	public async refresh(): Promise<void> {
		await this.ensureInitialized();
		await this.performRefresh();
	}

	/**
	 * Get symbol data.
	 * Returns `null` if the symbol is not found or is inactive.
	 */
	public async get(symbol: string): Promise<MarketSymbolRow | null> {
		const db = await this.ensureInitialized();

		const result = await db.query<MarketSymbolRow>(
			"SELECT symbol, type, class, name, ts, active FROM nasdaq_symbols WHERE symbol = ? AND active = true LIMIT 1",
			[symbol.toUpperCase()],
		);

		if (result.status === "success" && result.value.rows.length > 0) {
			return result.value.rows[0];
		}
		return null;
	}

	/**
	 * Graceful shutdown – disconnects the database driver.
	 */
	public async close(): Promise<void> {
		if (this.db) {
			await this.db.disconnect();
			this.db = null;
		}
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	/**
	 * Initializes the database driver if not already done.
	 * Creates the `nasdaq_symbols` table if it doesn't exist.
	 * Creates an index on the `active` column if it doesn't exist.
	 * Called automatically on first use, and before any other operations.
	 */
	private async ensureInitialized(): Promise<Database> {
		if (this.db) return this.db;

		this.db = await createDatabase(this.config as any);

		await this.db.query(`
			CREATE TABLE IF NOT EXISTS nasdaq_symbols (
				symbol   TEXT PRIMARY KEY,
				type     TEXT NOT NULL,
				class    TEXT NOT NULL,
				name     TEXT NOT NULL,
				ts       INTEGER NOT NULL,
				active   BOOLEAN NOT NULL DEFAULT true
			)
		`);

		await this.db.query(
			"CREATE INDEX IF NOT EXISTS idx_nasdaq_symbols_active ON nasdaq_symbols(active)",
		);

		// Auto-refresh on first use if needed
		await this.performRefresh();

		return this.db;
	}

	/**
	 * Checks if the database needs to be refreshed.
	 * Returns true if the database has never been populated, or if the last refresh was not today.
	 * @returns {Promise<boolean>} true if the database needs to be refreshed
	 */
	private async needsRefresh(): Promise<boolean> {
		if (!this.db) return true;

		const result = await this.db.query<{ max_ts: number | null }>(
			"SELECT MAX(ts) AS max_ts FROM nasdaq_symbols LIMIT 1",
		);

		if (result.status === "error") return true;

		const maxTs = result.value.rows[0]?.max_ts;
		if (!maxTs) return true;

		const lastDate = DateTime.fromMillis(maxTs)
			.setZone("America/New_York")
			.startOf("day");
		const today = DateTime.now().setZone("America/New_York").startOf("day");

		return !lastDate.equals(today);
	}

	/**
	 * Refreshes the symbol database.
	 * Only runs if the database has never been populated, or if the last refresh was not today.
	 * Downloads the official Nasdaq symbol directories, parses them, and updates the database.
	 * @returns {Promise<void>} resolves after the database has been refreshed
	 */
	private async performRefresh(): Promise<void> {
		if (!(await this.needsRefresh())) return;
		if (!this.db) return;

		logger.info("[MarketSymbols] Starting full symbol directory refresh");

		const texts = await this.fetchSymbolFilesWithRetry();

		const nasdaqRows = this.parseNasdaqListed(texts.nasdaqText);
		const otherRows = this.parseOtherListed(texts.otherText);

		const allRows = new Map<string, MarketSymbolRow>();
		for (const r of nasdaqRows) allRows.set(r.symbol, r);
		for (const r of otherRows) {
			if (!allRows.has(r.symbol)) allRows.set(r.symbol, r);
		}

		const now = Date.now();
		const rowsArray = Array.from(allRows.values()).map((r) => ({
			...r,
			ts: now,
		}));

		await this.db.transaction(async () => {
			if (!this.db) throw new Error("Database lost during transaction");

			await this.db.query("UPDATE nasdaq_symbols SET active = false");

			// Batch inserts to stay within SQLite parameter limits (max 999)
			// We have 6 fields per row, so ~150 rows per batch
			const BATCH_SIZE = 150;
			for (let i = 0; i < rowsArray.length; i += BATCH_SIZE) {
				const batch = rowsArray.slice(i, i + BATCH_SIZE);
				const placeholders = batch.map(() => "(?, ?, ?, ?, ?, true)").join(", ");
				const params = batch.flatMap((r) => [
					r.symbol,
					r.type,
					r.class,
					r.name,
					r.ts,
				]);

				await this.db.query(
					`INSERT INTO nasdaq_symbols (symbol, type, class, name, ts, active)
					 VALUES ${placeholders}
					 ON CONFLICT(symbol) DO UPDATE SET
						type   = excluded.type,
						class  = excluded.class,
						name   = excluded.name,
						ts     = excluded.ts,
						active = true`,
					params,
				);
			}

			return {
				status: "success" as const,
				value: null,
			} as DatabaseResult<null>;
		});
	}

	/**
	 * Downloads the official Nasdaq symbol directories with retry.
	 * If any of the fetches fail, the function will retry with an exponential backoff (up to 1 hour).
	 * If there is existing data in the database, the function will retry indefinitely.
	 * If there is no existing data, the function will throw an error on the first failure.
	 * @returns {Promise<{ nasdaqText: string; otherText: string }>} resolves with the content of the two files as strings
	 */
	private async fetchSymbolFilesWithRetry(): Promise<{
		nasdaqText: string;
		otherText: string;
	}> {
		let backoffMs = 1000;

		while (true) {
			try {
				const results = await endPoints<string>(
					[NASDAQ_LISTED_URL, OTHER_LISTED_URL],
					{
						headers: {
							accept: "text/plain, */*",
							"user-agent":
								"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
						},
					},
				);

				if (
					results[0].status === "success" &&
					results[1].status === "success"
				) {
					return {
						nasdaqText: results[0].value.body as string,
						otherText: results[1].value.body as string,
					};
				}

				// Identify which one failed (or both)
				const errorResult =
					results[0].status === "error" ? results[0] : (results[1] as any);
				const reason = errorResult.reason;

				logger.warn("[MarketSymbols] Symbol directory fetch failed – retrying", {
					reason,
				});

				const hasExistingData = await this.hasExistingData();
				if (hasExistingData) {
					await sleep(backoffMs);
					backoffMs = Math.min(backoffMs * 2, 3_600_000); // max 1 hour
					continue;
				}

				// Fatal on first-time failure
				throw new Error(
					`Failed to construct symbols db - ${reason.message || JSON.stringify(reason)}`,
				);
			} catch (err: any) {
				const hasExistingData = await this.hasExistingData();
				if (hasExistingData) {
					logger.warn(
						"[MarketSymbols] Symbol directory fetch thrown – retrying",
						{ error: err.message },
					);
					await sleep(backoffMs);
					backoffMs = Math.min(backoffMs * 2, 3_600_000);
					continue;
				}
				throw err;
			}
		}
	}

	/**
	 * Checks if there is existing data in the database.
	 * Returns true if there is any existing data, false otherwise.
	 * @returns {Promise<boolean>} true if there is any existing data, false otherwise
	 */
	private async hasExistingData(): Promise<boolean> {
		if (!this.db) return false;

		const res = await this.db.query<{ count: number }>(
			"SELECT COUNT(*) AS count FROM nasdaq_symbols LIMIT 1",
		);

		if (res.status === "success") {
			return (res.value.rows[0]?.count ?? 0) > 0;
		}
		return false;
	}

	/**
	 * Parses the official Nasdaq symbol directory file (nasdaqlisted.txt).
	 * Skips the first two lines (header) and empty lines.
	 * Skips lines with less than 8 fields (invalid).
	 * Extracts the symbol, name, and ETF status from the line.
	 * Creates a MarketSymbolRow with the extracted data and adds it to the result array.
	 * @param {string} text - The content of the nasdaqlisted.txt file as a string
	 * @returns {MarketSymbolRow[]} - An array of MarketSymbolRow objects parsed from the file
	 */
	private parseNasdaqListed(text: string): MarketSymbolRow[] {
		const rows: MarketSymbolRow[] = [];
		const lines = text.trim().split(/\r?\n/);

		for (const line of lines) {
			if (
				line.startsWith("Symbol|") ||
				line.startsWith("File Creation Time|") ||
				!line.trim()
			)
				continue;
			const fields = line.split("|");
			if (fields.length < 8) continue;

			const symbol = fields[0].trim();
			const name = fields[1].trim();
			const isEtf = fields[6] === "Y";

			rows.push({
				symbol,
				name,
				type: "rt",
				class: isEtf ? Realtime.Etf : Realtime.Stocks,
				ts: 0,
				active: true,
			});
		}
		return rows;
	}

	/**
	 * Parses the official Nasdaq symbol directory file (otherlisted.txt).
	 * Skips the first two lines (header) and empty lines.
	 * Skips lines with less than 5 fields (invalid).
	 * Extracts the symbol, name, and ETF status from the line.
	 * Creates a MarketSymbolRow with the extracted data and adds it to the result array.
	 * @param {string} text - The content of the otherlisted.txt file as a string
	 * @returns {MarketSymbolRow[]} - An array of MarketSymbolRow objects parsed from the file
	 */
	private parseOtherListed(text: string): MarketSymbolRow[] {
		const rows: MarketSymbolRow[] = [];
		const lines = text.trim().split(/\r?\n/);

		for (const line of lines) {
			if (
				line.startsWith("Symbol|") ||
				line.startsWith("File Creation Time|") ||
				!line.trim()
			)
				continue;
			const fields = line.split("|");
			if (fields.length < 5) continue;

			const symbol = fields[0].trim();
			const name = fields[1].trim();
			const isEtf = fields[4] === "Y";

			rows.push({
				symbol,
				name,
				type: "rt",
				class: isEtf ? Realtime.Etf : Realtime.Stocks,
				ts: 0,
				active: true,
			});
		}
		return rows;
	}
}
