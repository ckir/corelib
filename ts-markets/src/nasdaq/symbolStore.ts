// =============================================
// FILE: ts-markets/src/nasdaq/symbolStore.ts
// PURPOSE: Storage contract for the Nasdaq symbol directory, implemented by the SQL and MongoDB stores.
// =============================================

import type { MarketSymbolRow } from "./MarketSymbols";

/** Persistence backend for the symbol directory. */
export interface SymbolStore {
	/** Creates the schema if needed. Idempotent and safe to call concurrently. */
	init(): Promise<void>;
	/** Returns the active row for a symbol (case-insensitive), or null. */
	find(symbol: string): Promise<MarketSymbolRow | null>;
	/** Returns the newest row timestamp, or null when the store is empty. */
	lastRefreshTs(): Promise<number | null>;
	/** Returns the number of stored rows. */
	count(): Promise<number>;
	/** Atomically replaces the whole symbol set; rejects (leaving the old set intact) on failure. */
	replaceAll(rows: MarketSymbolRow[], refreshTs: number): Promise<void>;
	/** Releases resources the store owns. */
	close(): Promise<void>;
}

/** A SymbolStore is recognised by its replaceAll method (a Database has query/transaction instead). */
export function isSymbolStore(arg: unknown): arg is SymbolStore {
	return (
		typeof arg === "object" &&
		arg !== null &&
		typeof (arg as { replaceAll?: unknown }).replaceAll === "function"
	);
}

/** Thrown when a backend is unreachable (as opposed to a query-level failure). */
export class SymbolStoreUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SymbolStoreUnavailableError";
	}
}
