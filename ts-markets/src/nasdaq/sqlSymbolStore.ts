// =============================================
// FILE: ts-markets/src/nasdaq/sqlSymbolStore.ts
// PURPOSE: SymbolStore backed by SQLite or Turso (the SQL previously inlined in MarketSymbols).
// =============================================

import {
	createDatabase,
	type Database,
	type DatabaseResult,
} from "@ckirg/corelib";
import type { MarketSymbolRow } from "./MarketSymbols";
import type { SymbolStore } from "./symbolStore";

export type SqlStoreConfig = {
	dialect: "sqlite";
	url: string;
	mode: "stateful" | "stateless";
	authToken?: string;
};

export class SqlSymbolStore implements SymbolStore {
	private db: Database | null;
	private initPromise: Promise<void> | null = null;

	private constructor(
		db: Database | null,
		private readonly config: SqlStoreConfig | undefined,
		private readonly owner: boolean,
	) {
		this.db = db;
	}

	/** Wraps an existing database; close() never disconnects it. */
	static fromDatabase(db: Database): SqlSymbolStore {
		return new SqlSymbolStore(db, undefined, false);
	}

	/** Creates the database in init(); close() disconnects it. */
	static fromConfig(config: SqlStoreConfig): SqlSymbolStore {
		return new SqlSymbolStore(null, config, true);
	}

	init(): Promise<void> {
		this.initPromise ??= this.doInit().catch((e) => {
			this.initPromise = null;
			throw e;
		});
		return this.initPromise;
	}

	private async doInit(): Promise<void> {
		if (!this.db) {
			if (!this.config) {
				throw new Error("SqlSymbolStore: no database and no configuration");
			}
			this.db = await createDatabase(this.config);
		}
		const db = this.db;

		await db.query(`
			CREATE TABLE IF NOT EXISTS nasdaq_symbols (
				symbol   TEXT PRIMARY KEY,
				type     TEXT NOT NULL,
				class    TEXT NOT NULL,
				name     TEXT NOT NULL,
				ts       INTEGER NOT NULL,
				active   BOOLEAN NOT NULL DEFAULT true
			)
		`);

		await db.query(
			"CREATE INDEX IF NOT EXISTS idx_nasdaq_symbols_active ON nasdaq_symbols(active)",
		);
	}

	private async ready(): Promise<Database> {
		await this.init();
		if (!this.db) throw new Error("SqlSymbolStore: database unavailable");
		return this.db;
	}

	async find(symbol: string): Promise<MarketSymbolRow | null> {
		const db = await this.ready();
		const result = await db.query<MarketSymbolRow>(
			"SELECT symbol, type, class, name, ts, active FROM nasdaq_symbols WHERE symbol = ? AND active = true LIMIT 1",
			[symbol.toUpperCase()],
		);
		if (result.status === "error") {
			throw new Error("Symbol lookup failed", { cause: result.reason });
		}
		const found = result.value.rows[0];
		// SQLite stores booleans as 0/1; MarketSymbolRow.active is a boolean.
		return found ? { ...found, active: Boolean(found.active) } : null;
	}

	async lastRefreshTs(): Promise<number | null> {
		const db = await this.ready();
		const result = await db.query<{ max_ts: number | null }>(
			"SELECT MAX(ts) AS max_ts FROM nasdaq_symbols LIMIT 1",
		);
		if (result.status === "error") {
			throw new Error("Reading the last refresh time failed", {
				cause: result.reason,
			});
		}
		const max = result.value.rows[0]?.max_ts;
		return max === null || max === undefined ? null : Number(max);
	}

	async count(): Promise<number> {
		const db = await this.ready();
		const res = await db.query<{ count: number }>(
			"SELECT COUNT(*) AS count FROM nasdaq_symbols LIMIT 1",
		);
		if (res.status === "error") {
			throw new Error("Counting symbols failed", { cause: res.reason });
		}
		return Number(res.value.rows[0]?.count ?? 0);
	}

	async replaceAll(rows: MarketSymbolRow[], _refreshTs: number): Promise<void> {
		if (rows.length === 0) {
			throw new Error("Refusing to replace the symbol set with zero rows");
		}
		const db = await this.ready();

		const refreshTx = await db.transaction(async () => {
			// db.query reports failures as { status: "error" } instead of throwing, and the transaction
			// commits whenever this callback returns success. Return the first failure so the whole
			// refresh (including the deactivation below) rolls back.
			const deactivated = await db.query(
				"UPDATE nasdaq_symbols SET active = false",
			);
			if (deactivated.status === "error") {
				return {
					status: "error" as const,
					reason: deactivated.reason,
				} as DatabaseResult<null>;
			}

			// Batch inserts to stay within SQLite parameter limits (max 999)
			// We have 6 fields per row, so ~150 rows per batch
			const BATCH_SIZE = 150;
			for (let i = 0; i < rows.length; i += BATCH_SIZE) {
				const batch = rows.slice(i, i + BATCH_SIZE);
				const placeholders = batch
					.map(() => "(?, ?, ?, ?, ?, true)")
					.join(", ");
				const params = batch.flatMap((r) => [
					r.symbol,
					r.type,
					r.class,
					r.name,
					r.ts,
				]);

				const inserted = await db.query(
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
				if (inserted.status === "error") {
					return {
						status: "error" as const,
						reason: inserted.reason,
					} as DatabaseResult<null>;
				}
			}

			return {
				status: "success" as const,
				value: null,
			} as DatabaseResult<null>;
		});

		if (refreshTx.status === "error") {
			throw new Error(
				"Symbol refresh failed; the transaction was rolled back",
				{
					cause: refreshTx.reason,
				},
			);
		}
	}

	async close(): Promise<void> {
		if (this.owner && this.db) {
			await this.db.disconnect();
			this.db = null;
			this.initPromise = null;
		}
	}
}
