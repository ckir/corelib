import { serializeError } from "serialize-error";
import { nextCid } from "../../utils/flight-recorder";
import { type DatabaseResult, wrapError } from "../core/result";
import { redactParams } from "../redact";
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
	async query<T = unknown>(
		sql: string,
		params?: QueryParams,
	): Promise<DatabaseResult<QueryResponse<T>>> {
		const qid = nextCid();
		const txDriver = getActiveTransaction();
		const activeDriver = txDriver || this.driver;
		const startedAt = performance.now();
		this.config.logger?.trace("query: exec", {
			qid,
			sql,
			hasParams: params != null,
			nested: txDriver != null,
			// Params logged ONLY when the project opted in with a redactor (default: off).
			...(this.config.paramRedactor && params != null
				? { params: redactParams(params, this.config.paramRedactor) }
				: {}),
		});

		try {
			if (!txDriver) {
				await activeDriver.connect();
			}

			const result = await activeDriver.query<T>(sql, params);
			const durationMs = performance.now() - startedAt;

			if (result.status === "error") {
				this.config.logger?.trace("query: error", {
					qid,
					durationMs,
					errorMsg: result.reason?.message ?? "unknown error",
				});
				this.config.logger?.error("Query execution failed", {
					sql,
					reason: result.reason,
				});
			}
			if (result.status === "success") {
				this.config.logger?.trace("query: ok", {
					qid,
					durationMs,
					rows: result.value?.rows?.length ?? 0,
					affectedRows: result.value?.affectedRows ?? 0,
					lastInsertId: result.value?.lastInsertId,
				});
			}
			return result;
		} catch (e) {
			const durationMs = performance.now() - startedAt;
			this.config.logger?.trace("query: error", {
				qid,
				durationMs,
				errorMsg: e instanceof Error ? e.message : String(e),
			});
			this.config.logger?.error("Query catastrophic failure", {
				sql,
				error: serializeError(e),
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
		this.config.logger?.trace("tx: begin", { isNested });

		try {
			await driver.connect();
			if (isNested) {
				const spResult = await driver.query(`SAVEPOINT ${savepointName}`);
				if (spResult.status === "error") {
					throw new Error(
						`Failed to create savepoint: ${JSON.stringify(spResult.reason)}`,
					);
				}
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
					this.config.logger?.trace("tx: commit", { isNested });
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
				error: serializeError(e),
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
					error: serializeError(rollbackErr),
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
