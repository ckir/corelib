import { type DatabaseResult, wrapError } from "../core/result";
import {
	getActiveTransaction,
	runInTransaction,
} from "../core/transaction-context";
import type { QueryParams, QueryResponse } from "../core/types";
import type { SqliteConfig } from "./sqlite-config";
import { SqliteDriver } from "./sqlite-driver";

/**
 * Public SqliteDb implementation.
 * Provides high-level API for SQLite/LibSQL, handling connections, transactions, and result normalization.
 */
export class SqliteDb {
	private driver: SqliteDriver;

	constructor(private config: SqliteConfig) {
		this.driver = new SqliteDriver(config);
	}

	/**
	 * Executes a single SQL query.
	 * Joins active transaction if called within a transaction block.
	 */
	async query<T = any>(
		sql: string,
		params?: QueryParams,
	): Promise<DatabaseResult<QueryResponse<T>>> {
		const txDriver = getActiveTransaction();
		const activeDriver = txDriver || this.driver;

		try {
			if (!txDriver) {
				await activeDriver.connect();
			}

			const result = await activeDriver.query<T>(sql, params);

			if (result.status === "error") {
				this.config.logger?.error("Query execution failed", {
					sql,
					reason: result.reason,
				});
			}
			return result;
		} catch (e) {
			this.config.logger?.error("Query catastrophic failure", {
				sql,
				error: e,
			});
			return wrapError(e);
		} finally {
			if (!txDriver && this.config.mode === "stateless") {
				await activeDriver.disconnect();
			}
		}
	}

	/**
	 * Executes operations within a transaction using AsyncLocalStorage for context.
	 */
	async transaction<T>(
		callback: () => Promise<DatabaseResult<T>>,
	): Promise<DatabaseResult<T>> {
		try {
			await this.driver.connect();
			await this.driver.beginTransaction();

			return await runInTransaction(this.driver, async () => {
				const result = await callback();

				if (result.status === "success") {
					await this.driver.commitTransaction();
				} else {
					this.config.logger?.warn("Transaction rollback initiated", {
						reason: result.reason,
					});
					await this.driver.rollbackTransaction();
				}
				return result;
			});
		} catch (e) {
			this.config.logger?.error("Transaction failed due to exception", {
				error: e,
			});
			await this.driver.rollbackTransaction();
			return wrapError(e);
		} finally {
			if (this.config.mode === "stateless") {
				await this.driver.disconnect();
			}
		}
	}
}
