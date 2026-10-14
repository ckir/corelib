import { nextCid } from "../../utils/flight-recorder";
import { type DatabaseResult, wrapError } from "../core/result";
import { safeDbError } from "../core/safe-error";
import {
	getActiveTransaction,
	getActiveTxId,
	runInTransaction,
} from "../core/transaction-context";
import type { QueryParams, QueryResponse } from "../core/types";
import { redactParams } from "../redact";
import type { SqliteConfig } from "./sqlite-config";
import { SqliteDriver } from "./sqlite-driver";

/**
 * Public SqliteDb implementation.
 * Provides high-level API for SQLite/LibSQL, handling connections, transactions, and result normalization.
 */
export class SqliteDb {
	private driver: SqliteDriver;
	/** Tail of the top-level transaction queue (promise-chain mutex). */
	private txTail: Promise<void> = Promise.resolve();

	constructor(private config: SqliteConfig) {
		this.driver = new SqliteDriver(config);
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
		// Flight-recorder correlation: traceId follows one logical op across queries
		// (app-provided via getTraceId); txId groups queries within the current transaction.
		const traceId = this.config.getTraceId?.();
		const txId = getActiveTxId();
		const corr = {
			...(traceId != null ? { traceId } : {}),
			...(txId != null ? { txId } : {}),
		};
		this.config.logger?.trace("query: exec", {
			qid,
			...corr,
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
					...corr,
					durationMs,
					errorMsg: result.reason?.message ?? "unknown error",
				});
				this.config.logger?.error("Query execution failed", {
					reason: safeDbError(result.reason),
				});
			}
			if (result.status === "success") {
				this.config.logger?.trace("query: ok", {
					qid,
					...corr,
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
				...corr,
				durationMs,
				errorMsg: e instanceof Error ? e.message : String(e),
			});
			this.config.logger?.error("Query catastrophic failure", {
				error: safeDbError(e),
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
	 * Waits for every earlier top-level transaction to finish and returns the
	 * function that releases the lock for the next one. All top-level
	 * transactions share one driver client, so BEGIN must not interleave.
	 */
	private async acquireTxLock(): Promise<() => void> {
		let release!: () => void;
		const done = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = this.txTail;
		this.txTail = previous.then(() => done);
		await previous;
		return release;
	}

	/**
	 * Executes operations within a transaction using AsyncLocalStorage for context.
	 * Top-level transactions are serialised; nested calls (savepoints) never wait.
	 */
	async transaction<T>(
		callback: () => Promise<DatabaseResult<T>>,
	): Promise<DatabaseResult<T>> {
		const existingDriver = getActiveTransaction() as SqliteDriver | undefined;
		const driver = existingDriver || this.driver;
		const isNested = !!existingDriver;
		const txId = nextCid();
		const savepointName = `sp_${txId}`;
		this.config.logger?.trace("tx: begin", { txId, isNested });
		const releaseLock = isNested ? undefined : await this.acquireTxLock();

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

			return await runInTransaction(driver, txId, async () => {
				const result = await callback();

				if (result.status === "success") {
					if (isNested) {
						await driver.query(`RELEASE SAVEPOINT ${savepointName}`);
					} else {
						await driver.commitTransaction();
					}
					this.config.logger?.trace("tx: commit", { txId, isNested });
				} else {
					this.config.logger?.warn("Transaction rollback initiated", {
						txId,
						reason: safeDbError(result.reason),
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
				error: safeDbError(e),
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
					error: safeDbError(rollbackErr),
				});
			}
			return wrapError(e);
		} finally {
			try {
				if (!isNested && this.config.mode === "stateless") {
					await driver.disconnect();
				}
			} finally {
				releaseLock?.();
			}
		}
	}
}
