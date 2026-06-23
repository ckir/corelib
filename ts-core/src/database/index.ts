/**
 * @file ts-core/src/database/index.ts
 * @description Main entry point for the database module, exporting factory functions and core components.
 */

import type { Database } from "./core/types.js";
import type { PostgresConfig } from "./postgres/postgres-config.js";
import { PostgresDb } from "./postgres/postgres-db.js";
import type { SqliteConfig } from "./sqlite/sqlite-config.js";
import { SqliteDb } from "./sqlite/sqlite-db.js";

export * from "./core/driver.js";
export * from "./core/errors.js";
export * from "./core/result.js";
export * from "./core/transaction-context.js";
export * from "./core/types.js";
export * from "./postgres/index.js";
export * from "./redact.js";
export * from "./sqlite/index.js";

/**
 * Factory function to create a database instance based on the configuration.
 * It automatically selects the correct implementation (Postgres or SQLite) based on the `dialect` field.
 *
 * @param {SqliteConfig | PostgresConfig} config - The database configuration.
 * @returns {Promise<Database>} A promise resolving to a Database instance.
 */
export async function createDatabase(
	config: SqliteConfig | PostgresConfig,
): Promise<Database> {
	if (config.dialect === "postgres") {
		return new PostgresDb(config as any);
	}
	return new SqliteDb(config as any);
}

/**
 * Database section containing metadata and core components.
 */
export const DatabaseSection = {
	/**
	 * Current status of the database section.
	 */
	status: "active" as const,
	/**
	 * Reference to the default Database implementation (SqliteDb).
	 */
	Database: SqliteDb,
	/**
	 * Factory function to create a database instance.
	 */
	createDatabase,
};
