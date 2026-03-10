import type { DbDriver, PreparedDriverStatement } from "../core/driver";
import { type DatabaseResult, wrapError, wrapSuccess } from "../core/result";
import type { QueryParams, QueryResponse } from "../core/types";
import type { PostgresConfig } from "./postgres-config";

export class PostgresDriver implements DbDriver {
	private client: any = null;

	constructor(private config: PostgresConfig) {}

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
		if (this.client) {
			await this.client.end();
			this.client = null;
		}
	}

	async query<T = any>(
		sql: string,
		params?: QueryParams,
	): Promise<DatabaseResult<QueryResponse<T>>> {
		try {
			const res = await this.client(sql, params);
			return wrapSuccess({
				rows: res as unknown as T[],
				affectedRows: res.count,
				// lastInsertId not native; use RETURNING
			});
		} catch (e) {
			return wrapError(e);
		}
	}

	async prepare(sql: string): Promise<DatabaseResult<PreparedDriverStatement>> {
		try {
			const prepared = this.client.prepare(sql);
			return wrapSuccess({
				execute: async <T>(params?: QueryParams) => {
					try {
						const res = await prepared(params);
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
		await this.client`BEGIN`;
	}
	async commitTransaction(): Promise<void> {
		await this.client`COMMIT`;
	}
	async rollbackTransaction(): Promise<void> {
		await this.client`ROLLBACK`;
	}

	async stream<T>(
		sql: string,
		params: QueryParams,
		onRow: (row: T) => void,
	): Promise<DatabaseResult<void>> {
		try {
			for await (const row of this.client(sql, params)) {
				onRow(row as T);
			}
			return wrapSuccess(undefined);
		} catch (e) {
			return wrapError(e);
		}
	}
}
