import { type DatabaseResult, wrapError } from "../core/result";
import {
	getActiveTransaction,
	runInTransaction,
} from "../core/transaction-context";
import type { QueryParams, QueryResponse } from "../core/types";
import type { PostgresConfig } from "./postgres-config";
import { PostgresDriver } from "./postgres-driver";

/**
 * Public PostgresDb implementation.
 * Provides high-level API for Postgres, handling connections, transactions, and result normalization.
 * Note: For lastInsertId, use RETURNING clauses in your INSERT queries as Postgres does not provide it natively.
 */
export class PostgresDb {
	private driver: PostgresDriver;

	constructor(private config: PostgresConfig) {
		this.driver = new PostgresDriver(config);
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
	 * Disconnects from the database.
	 */
	async disconnect(): Promise<void> {
		await this.driver.disconnect();
	}

	/**
	 * Executes operations within a transaction using AsyncLocalStorage for context.
	 */
	async transaction<T>(
		callback: () => Promise<DatabaseResult<T>>,
	): Promise<DatabaseResult<T>> {
		const existingDriver = getActiveTransaction() as PostgresDriver | undefined;
		const driver = existingDriver || this.driver;
		const isNested = !!existingDriver;
		const savepointName = `sp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

		try {
			await driver.connect();
			if (isNested) {
				await driver.query(`SAVEPOINT ${savepointName}`);
			} else {
				await driver.beginTransaction();
			}

			return await runInTransaction(driver, async () => {
				const result = await callback();

				if (result.status === "success") {
					if (isNested) {
						await driver.query(`RELEASE SAVEPOINT ${savepointName}`);
					} else {
						await driver.commitTransaction();
					}
				} else {
					this.config.logger?.warn("Transaction rollback initiated", {
						reason: result.reason,
						isNested,
					});
					if (isNested) {
						await driver.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
					} else {
						await driver.rollbackTransaction();
					}
				}
				return result;
			});
		} catch (e) {
			this.config.logger?.error("Transaction failed due to exception", {
				error: e,
				isNested,
			});
			try {
				if (isNested) {
					await driver.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
				} else {
					await driver.rollbackTransaction();
				}
			} catch (rollbackErr) {
				this.config.logger?.error("Failed to rollback transaction", {
					error: rollbackErr,
				});
			}
			return wrapError(e);
		} finally {
			if (!isNested && this.config.mode === "stateless") {
				await driver.disconnect();
			}
		}
	}
}
