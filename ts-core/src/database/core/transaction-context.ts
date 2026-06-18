import { serializeError } from "serialize-error";
import logger from "../../loggers/index.js";
import { detectRuntime } from "../../utils/runtime.js";
import type { DbDriver } from "./driver.js";

const transactionLogger = logger.child({ section: "TransactionContext" });

/**
 * High-performance polyfill/loader for AsyncLocalStorage across runtimes.
 * Node/Bun use node:async_hooks, while Deno uses std/node compatibility.
 */

// Define internal types to avoid any
export interface AsyncLocalStorageLike<T> {
	run<R>(store: T, callback: () => R): R;
	getStore(): T | undefined;
}

const runtime = detectRuntime();

async function loadAsyncLocalStorage<T>(): Promise<
	AsyncLocalStorageLike<T> | undefined
> {
	try {
		if (runtime === "deno") {
			// Deno's std/node polyfill is safer for ESM/DTS build compatibility than URL imports
			const { AsyncLocalStorage } = await import("node:async_hooks");
			return new AsyncLocalStorage<T>();
		}

		// Node/Bun native
		const { AsyncLocalStorage } = await import("node:async_hooks");
		return new AsyncLocalStorage<T>();
	} catch (e) {
		transactionLogger.error("Failed to load AsyncLocalStorage", {
			error: serializeError(e),
		});
		return undefined;
	}
}

/** Active-transaction context carried via AsyncLocalStorage. */
interface TransactionContext {
	driver: DbDriver;
	/** Flight-recorder id for the transaction; stamped on every query run within it. */
	txId: number;
}

// Global storage singleton (dynamically initialized)
export const transactionStorage =
	await loadAsyncLocalStorage<TransactionContext>();

/**
 * Gets the active transaction driver from context.
 */
export function getActiveTransaction(): DbDriver | undefined {
	return transactionStorage?.getStore()?.driver;
}

/**
 * Gets the active transaction's flight-recorder id, or undefined outside a transaction.
 */
export function getActiveTxId(): number | undefined {
	return transactionStorage?.getStore()?.txId;
}

/**
 * Runs a callback within a transaction context.
 * Internal helper used by DB implementations.
 */
export async function runInTransaction<T>(
	driver: DbDriver,
	txId: number,
	callback: () => Promise<T>,
): Promise<T> {
	if (!transactionStorage) {
		return callback();
	}
	return transactionStorage.run({ driver, txId }, callback);
}
