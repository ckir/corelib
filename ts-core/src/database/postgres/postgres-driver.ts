import type { ReservedSql, Sql } from "postgres";
import type { DbDriver, PreparedDriverStatement } from "../core/driver";
import { type DatabaseResult, wrapError, wrapSuccess } from "../core/result";
import type { QueryParams, QueryResponse } from "../core/types";
import type { PostgresConfig } from "./postgres-config";

/** Parameter list type accepted by postgres.js `unsafe()`. */
type UnsafeParams = NonNullable<Parameters<Sql["unsafe"]>[1]>;

export class PostgresDriver implements DbDriver {
	// Typed after dynamic import; null until connect() is called
	private client: Sql | ReservedSql | null = null;
	// Set only on a transaction-scoped driver (see reserve()); returns the connection to the pool.
	private releaseConnection: (() => void) | null = null;

	constructor(
		private config: PostgresConfig,
		reserved?: ReservedSql,
	) {
		if (reserved) {
			this.client = reserved;
			this.releaseConnection = () => reserved.release();
		}
	}

	/**
	 * Reserves one pooled connection and returns a driver bound to it.
	 * BEGIN, every statement in the transaction, and COMMIT/ROLLBACK all run on that
	 * single connection; the pool would otherwise spread them across connections.
	 * The connection is returned to the pool on commit, rollback or release().
	 */
	async reserve(): Promise<PostgresDriver> {
		await this.connect();
		const pool = this.client as Sql;
		return new PostgresDriver(this.config, await pool.reserve());
	}

	/** Returns a reserved connection to the pool. Idempotent; no-op on a pool driver. */
	async release(): Promise<void> {
		const release = this.releaseConnection;
		this.releaseConnection = null;
		release?.();
	}

	async connect(): Promise<void> {
		if (this.client) return;
		const sql = (await import("postgres")).default;
		this.client = sql(this.config.url, {
			max: this.config.maxConnections,
			ssl: this.config.ssl,
			connect_timeout: this.config.timeoutMs
				? this.config.timeoutMs / 1000
				: undefined,
		});
	}

	async disconnect(): Promise<void> {
		if (this.releaseConnection) {
			await this.release();
			return;
		}
		if (this.client) {
			// Only a pool driver reaches here, so the client is a full Sql instance.
			await (this.client as Sql).end();
			this.client = null;
		}
	}

	async query<T = unknown>(
		sql: string,
		params?: QueryParams,
	): Promise<DatabaseResult<QueryResponse<T>>> {
		try {
			// use unsafe() because we receive raw strings from the higher level Database API.
			// QueryParams values are runtime-validated by callers; bridge to postgres.js expected type.
			// postgres.js ParameterOrJSON[] is incompatible with unknown[], cast required
			const queryParams = (
				Array.isArray(params) ? params : params ? Object.values(params) : []
			) as UnsafeParams;
			const client = this.client;
			if (!client) throw new Error("Not connected");
			const res = await client.unsafe(sql, queryParams);
			return wrapSuccess({
				rows: res as unknown as T[],
				affectedRows: res.count,
			});
		} catch (e) {
			return wrapError(e);
		}
	}

	async prepare(sql: string): Promise<DatabaseResult<PreparedDriverStatement>> {
		try {
			// postgres.js prepared is not directly accessible via unsafe() this way,
			// but we can use the main client function as it is already optimized.
			// However, for consistency we'll use a wrapper.
			return wrapSuccess({
				execute: async <T>(params?: QueryParams) => {
					try {
						// postgres.js ParameterOrJSON[] is incompatible with unknown[], cast required
						const queryParams = (
							Array.isArray(params)
								? params
								: params
									? Object.values(params)
									: []
						) as UnsafeParams;
						const prepClient = this.client;
						if (!prepClient) throw new Error("Not connected");
						const res = await prepClient.unsafe(sql, queryParams);
						return wrapSuccess({
							rows: res as unknown as T[],
							affectedRows: res.count,
						});
					} catch (e) {
						return wrapError(e);
					}
				},
				close: async () => {
					/* postgres.js prepared is not closable */
				},
			});
		} catch (e) {
			return wrapError(e);
		}
	}

	async beginTransaction(): Promise<void> {
		await this.client?.unsafe("BEGIN");
	}
	async commitTransaction(): Promise<void> {
		try {
			await this.client?.unsafe("COMMIT");
		} finally {
			await this.release();
		}
	}
	async rollbackTransaction(): Promise<void> {
		try {
			await this.client?.unsafe("ROLLBACK");
		} finally {
			await this.release();
		}
	}

	async stream<T>(
		sql: string,
		params: QueryParams,
		onRow: (row: T) => void,
	): Promise<DatabaseResult<void>> {
		try {
			// postgres.js ParameterOrJSON[] is incompatible with unknown[], cast required
			const queryParams = (
				Array.isArray(params) ? params : params ? Object.values(params) : []
			) as UnsafeParams;
			const client = this.client;
			if (!client) throw new Error("Not connected");
			for await (const row of client.unsafe(sql, queryParams).cursor()) {
				onRow(row as T);
			}
			return wrapSuccess(undefined);
		} catch (e) {
			return wrapError(e);
		}
	}
}
