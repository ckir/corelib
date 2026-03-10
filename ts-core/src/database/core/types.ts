import type { StrictLogger } from "../../loggers/common/index.js";

/**
 * Type alias for the library's strict logger.
 */
export type LibraryLogger = StrictLogger;

/**
 * Database operation mode.
 * - 'stateless': Connects and disconnects for each operation (suitable for serverless/edge).
 * - 'stateful': Maintains persistent connections (suitable for long-running servers).
 */
export type DbMode = "stateless" | "stateful";

/**
 * Base configuration for all database dialects.
 */
export interface BaseDbConfig {
	/** Database dialect to use. */
	dialect: "sqlite" | "postgres";
	/** Database URL (e.g., 'file:local.db' for SQLite, 'postgres://user:pass@host/db' for Postgres). */
	url: string;
	/** Operation mode. */
	mode: DbMode;
	/** Logger instance (defaults to global logger.child({ section: 'Database' })). */
	logger?: LibraryLogger;
	/** Query timeout in milliseconds. */
	timeoutMs?: number;
}

/** Parameters for SQL queries (positional or named). */
export type QueryParams = any[] | Record<string, any>;

/** Standard data structure for successful query results. */
export interface QueryResponse<T = any> {
	rows: T[];
	affectedRows?: number;
	/** Last insert ID (optional for Postgres; use RETURNING clauses). */
	lastInsertId?: string | number | bigint;
}

/**
 * Common interface for high-level Database implementations (SqliteDb, PostgresDb).
 */
export interface Database {
	query<T = any>(
		sql: string,
		params?: QueryParams,
	): Promise<import("./result").DatabaseResult<QueryResponse<T>>>;

	transaction<T>(
		callback: () => Promise<import("./result").DatabaseResult<T>>,
	): Promise<import("./result").DatabaseResult<T>>;

	/**
	 * Disconnects from the database (only useful in 'stateful' mode).
	 */
	disconnect(): Promise<void>;
}
