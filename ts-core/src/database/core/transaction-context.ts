import { detectRuntime } from "../../utils/runtime.js";
import type { DbDriver } from "./driver.js";

/**
 * High-performance polyfill/loader for AsyncLocalStorage across runtimes.
 * Node/Bun use node:async_hooks, while Deno uses std/node compatibility.
 */

// Define internal types to avoid any
interface AsyncLocalStorageLike<T> {
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
		console.error("[TransactionContext] Failed to load AsyncLocalStorage", e);
		return undefined;
	}
}

// Global storage singleton (dynamically initialized)
export const transactionStorage = await loadAsyncLocalStorage<DbDriver>();

/**
 * Gets the active transaction driver from context.
 */
export function getActiveTransaction(): DbDriver | undefined {
	return transactionStorage?.getStore();
}

/**
 * Runs a callback within a transaction context.
 * Internal helper used by DB implementations.
 */
export async function runInTransaction<T>(
	driver: DbDriver,
	callback: () => Promise<T>,
): Promise<T> {
	if (!transactionStorage) {
		return callback();
	}
	return transactionStorage.run(driver, callback);
}
