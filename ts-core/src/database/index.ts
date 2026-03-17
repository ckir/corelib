/**
 * @file packages/tsdk/packages/database/src/index.ts
 */

import type { BaseDbConfig, Database } from "./core/types.js";
import { PostgresDb } from "./postgres/postgres-db.js";
import { SqliteDb } from "./sqlite/sqlite-db.js";

export * from "./core/driver.js";
export * from "./core/errors.js";
export * from "./core/result.js";
export * from "./core/transaction-context.js";
export type { Database } from "./core/types.js";
export * from "./core/types.js";
export * from "./postgres/index.js";
export * from "./sqlite/index.js";

/**
 * Factory function to create a database instance based on the configuration.
 */
export async function createDatabase(config: BaseDbConfig): Promise<Database> {
	if (config.dialect === "postgres") {
		return new PostgresDb(config as any);
	}
	return new SqliteDb(config as any);
}

export const DatabaseSection = {
	status: "active" as const,
	Database: SqliteDb,
	createDatabase,
};
