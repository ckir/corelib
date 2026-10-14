import type { InArgs, Transaction } from "@libsql/client";
import type { DbDriver, PreparedDriverStatement } from "../core/driver";
import { type DatabaseResult, wrapError, wrapSuccess } from "../core/result";
import type { QueryParams, QueryResponse } from "../core/types";
import type { SqliteConfig } from "./sqlite-config";

/**
 * Handle from client.transaction(): it owns one pooled connection until commit(), rollback() or
 * close(). A BEGIN sent through client.execute() does NOT survive: the client's pool rolls back
 * any transaction still open when execute() returns its connection.
 */
type LibSQLTransaction = Pick<
	Transaction,
	"execute" | "commit" | "rollback" | "close"
>;

/** Structural shape of the @libsql/client Client we actually use in this driver. */
type LibSQLClient = {
	/** Opens a transaction on a dedicated connection (the official Client always has this). */
	transaction?(mode: "write" | "read" | "deferred"): Promise<LibSQLTransaction>;
	/** execute() accepts either a plain SQL string or a stmt object */
	execute(
		stmt: string | { sql: string; args: unknown[] | Record<string, unknown> },
	): Promise<{
		rows: unknown[];
		rowsAffected: number;
		lastInsertRowid?: bigint | null | undefined;
	}>;
	close(): void | Promise<void>;
	/** prepare() is a non-standard extension for streaming; optional since the official Client lacks it */
	prepare?: (sql: string) => {
		execute(args: unknown[] | Record<string, unknown>): Promise<{
			rows: unknown[];
			rowsAffected: number;
			lastInsertRowid?: bigint | null | undefined;
		}>;
		raw(args: unknown[] | Record<string, unknown>): Iterable<unknown[]>;
		close(): Promise<void>;
	};
};

export class SqliteDriver implements DbDriver {
	// Typed after dynamic import; null until connect() is called
	private client: LibSQLClient | null = null;

	// Set only on a transaction-bound driver (see reserve()); every statement then runs on it.
	private tx: LibSQLTransaction | null = null;

	constructor(
		private config: SqliteConfig,
		tx: LibSQLTransaction | null = null,
		parentClient: LibSQLClient | null = null,
	) {
		if (tx) {
			this.tx = tx;
			// The parent's client is shared: connect() must be a no-op (no PRAGMAs inside a
			// transaction) and disconnect() must never close it.
			this.client = parentClient;
		}
	}

	/**
	 * Opens a write transaction on its own connection and returns a driver bound to it. BEGIN,
	 * every statement, and COMMIT/ROLLBACK then run on that one connection. The caller must
	 * release() it (idempotent); commit() and rollback() also settle the handle.
	 */
	async reserve(): Promise<SqliteDriver> {
		await this.connect();
		const client = this.client;
		if (!client?.transaction) {
			throw new Error(
				"SqliteDriver: this @libsql/client instance does not support transactions",
			);
		}
		return new SqliteDriver(
			this.config,
			await client.transaction("write"),
			client,
		);
	}

	/** Closes a transaction-bound driver's handle (rolls back anything uncommitted). No-op otherwise. */
	async release(): Promise<void> {
		this.tx?.close();
	}

	async connect(): Promise<void> {
		if (this.client) return;
		const { createClient } = await import("@libsql/client");
		this.client = createClient({
			url: this.config.url,
			...(this.config.authToken !== undefined
				? { authToken: this.config.authToken }
				: {}),
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
		if (this.tx) {
			await this.release();
			return;
		}
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
			const executor = this.tx ?? this.client;
			if (!executor) throw new Error("Not connected");
			// params are caller-supplied; libsql validates them at runtime.
			const res = await executor.execute({
				sql,
				args: (params || []) as InArgs,
			});
			return wrapSuccess({
				rows: res.rows as unknown as T[],
				affectedRows: Number(res.rowsAffected),
				...(res.lastInsertRowid != null
					? { lastInsertId: res.lastInsertRowid.toString() }
					: {}),
			});
		} catch (e) {
			return wrapError(e);
		}
	}

	async prepare(sql: string): Promise<DatabaseResult<PreparedDriverStatement>> {
		try {
			if (this.tx) {
				throw new Error("prepare() is not supported inside a transaction");
			}
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
							...(res.lastInsertRowid != null
								? { lastInsertId: res.lastInsertRowid.toString() }
								: {}),
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
		if (this.tx) return; // reserve() already opened it (client.transaction issues BEGIN)
		await this.client?.execute("BEGIN");
	}
	async commitTransaction(): Promise<void> {
		// libsql settles the handle even when COMMIT fails; the caller's rollback() is then a safe no-op.
		if (this.tx) return this.tx.commit();
		await this.client?.execute("COMMIT");
	}
	async rollbackTransaction(): Promise<void> {
		if (this.tx) return this.tx.rollback();
		await this.client?.execute("ROLLBACK");
	}

	async stream<T>(
		sql: string,
		params: QueryParams,
		onRow: (row: T) => void,
	): Promise<DatabaseResult<void>> {
		try {
			if (this.tx) {
				throw new Error("stream() is not supported inside a transaction");
			}
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
