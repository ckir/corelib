// =============================================
// FILE: ts-markets/src/nasdaq/sqlSymbolStore.test.ts
// PURPOSE: Runs the shared SymbolStore contract against SqlSymbolStore on a real in-memory SQLite database.
// =============================================

import { createDatabase } from "@ckirg/corelib";
import { SqlSymbolStore } from "./sqlSymbolStore";
import { symbolStoreContract } from "./symbolStore.contract";

symbolStoreContract("SqlSymbolStore (in-memory SQLite)", async () => {
	const db = await createDatabase({
		dialect: "sqlite",
		url: ":memory:",
		mode: "stateful",
	} as never);
	// Production columns plus a constraint that makes any batch containing POISON fail.
	await db.query(`CREATE TABLE nasdaq_symbols (
		symbol TEXT PRIMARY KEY, type TEXT NOT NULL, class TEXT NOT NULL,
		name TEXT NOT NULL, ts INTEGER NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
		CHECK (symbol <> 'POISON'))`);
	return {
		store: SqlSymbolStore.fromDatabase(db),
		poison: (good) => [
			...good,
			{
				symbol: "POISON",
				name: "Poison",
				type: "rt",
				class: "stocks",
				ts: 1,
				active: true,
			},
		],
		cleanup: async () => {
			await db.disconnect();
		},
	};
});
