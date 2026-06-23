import type { DbDriver, PreparedDriverStatement } from "../core/driver";
import { type DatabaseResult, wrapError, wrapSuccess } from "../core/result";
import type { QueryParams, QueryResponse } from "../core/types";
import type { SqliteConfig } from "./sqlite-config";

/** Structural shape of the @libsql/client Client we actually use in this driver. */
type LibSQLClient = {
	/** execute() accepts either a plain SQL string or a stmt object */
	execute(
		stmt: string | { sql: string; args: unknown[] | Record<string, unknown> },
	): Promise<{
		rows: unknown[];
		rowsAffected: number;
		lastInsertRowid?: bigint | null;
	}>;
	close(): void | Promise<void>;
	/** prepare() is a non-standard extension for streaming; optional since the official Client lacks it */
	prepare?: (sql: string) => {
		execute(args: unknown[] | Record<string, unknown>): Promise<{
			rows: unknown[];
			rowsAffected: number;
			lastInsertRowid?: bigint | null;
		}>;
		raw(args: unknown[] | Record<string, unknown>): Iterable<unknown[]>;
		close(): Promise<void>;
	};
};

export class SqliteDriver implements DbDriver {
	// Typed after dynamic import; null until connect() is called
	private client: LibSQLClient | null = null;

	constructor(private config: SqliteConfig) {}

	async connect(): Promise<void> {
		if (this.client) return;
		const { createClient } = await import("@libsql/client");
		this.client = createClient({
			url: this.config.url,
			authToken: this.config.authToken,
		});
		// Opt-in only (config.journalMode) so shared-library consumers are unaffected.
		// Local SQLite files default to rollback-journal + FULL fsync (→ the 100-388ms
		// log writes observed). WAL + NORMAL makes them sequential appends (~1-5ms).
		// PRAGMA journal_mode is a no-op/unsupported on remote libsql (Turso), so also
		// gate on a local-file url shape.
		const isLocalFile = /^file:|\.db($|\?)|^\.{0,2}\//.test(this.config.url);
		if (this.config.journalMode && isLocalFile) {
			await this.client.execute(
				`PRAGMA journal_mode=${this.config.journalMode}`,
			);
			if (this.config.synchronous) {
				await this.client.execute(
					`PRAGMA synchronous=${this.config.synchronous}`,
				);
			}
		}
	}

	async disconnect(): Promise<void> {
		if (this.client) {
			await this.client.close();
			this.client = null;
		}
	}

	async query<T = unknown>(
		sql: string,
		params?: QueryParams,
	): Promise<DatabaseResult<QueryResponse<T>>> {
		try {
			if (!this.client) throw new Error("Not connected");
			const res = await this.client.execute({ sql, args: params || [] });
			return wrapSuccess({
				rows: res.rows as unknown as T[],
				affectedRows: Number(res.rowsAffected),
				lastInsertId: res.lastInsertRowid?.toString(),
			});
		} catch (e) {
			return wrapError(e);
		}
	}

	async prepare(sql: string): Promise<DatabaseResult<PreparedDriverStatement>> {
		try {
			if (!this.client?.prepare) {
				throw new Error(
					"prepare() is not supported by this @libsql/client instance",
				);
			}
			const stmt = this.client.prepare(sql);
			return wrapSuccess({
				execute: async <T>(params?: QueryParams) => {
					try {
						const res = await stmt.execute(params || []);
						return wrapSuccess({
							rows: res.rows as unknown as T[],
							affectedRows: Number(res.rowsAffected),
							lastInsertId: res.lastInsertRowid?.toString(),
						});
					} catch (e) {
						return wrapError(e);
					}
				},
				close: async () => await stmt.close(),
			});
		} catch (e) {
			return wrapError(e);
		}
	}

	async beginTransaction(): Promise<void> {
		await this.client?.execute("BEGIN");
	}
	async commitTransaction(): Promise<void> {
		await this.client?.execute("COMMIT");
	}
	async rollbackTransaction(): Promise<void> {
		await this.client?.execute("ROLLBACK");
	}

	async stream<T>(
		sql: string,
		params: QueryParams,
		onRow: (row: T) => void,
	): Promise<DatabaseResult<void>> {
		try {
			if (!this.client?.prepare) {
				throw new Error(
					"stream() via prepare() is not supported by this @libsql/client instance",
				);
			}
			const stmt = this.client.prepare(sql);
			const cursor = await stmt.raw(params || []);
			for (const row of cursor) {
				onRow(row as T);
			}
			await stmt.close();
			return wrapSuccess(undefined);
		} catch (e) {
			return wrapError(e);
		}
	}
}
