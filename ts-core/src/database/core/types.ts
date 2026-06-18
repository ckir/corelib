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
	/**
	 * Opt-in param logging for the Flight-Recorder query traces. When set, each query's
	 * params are passed through this redactor and logged under `params` on `query: exec`.
	 * Unset (the default) means params are NOT logged. Use the exported `defaultRedactor`
	 * (or a stricter one); the consuming project owns the residual leak risk.
	 */
	paramRedactor?: ParamRedactor;
}

/** Parameters for SQL queries (positional or named). */
export type QueryParams = unknown[] | Record<string, unknown>;

/** A param-redaction policy: receives ONE param value, returns its log-safe representation. */
export type ParamRedactor = (value: unknown) => unknown;

/** Standard data structure for successful query results. */
export interface QueryResponse<T = unknown> {
	/** Array of rows returned by the query. */
	rows: T[];
	/** Number of rows affected by the operation (e.g. on INSERT, UPDATE, DELETE). */
	affectedRows?: number;
	/** Last insert ID (optional for Postgres; use RETURNING clauses). */
	lastInsertId?: string | number | bigint;
}

/**
 * Common interface for high-level Database implementations (SqliteDb, PostgresDb).
 * Provides methods for querying and transaction management.
 */
export interface Database {
	/**
	 * Executes an SQL query and returns the results.
	 * @template T The expected type of the rows.
	 * @param {string} sql The SQL query string.
	 * @param {QueryParams} [params] Optional query parameters.
	 * @returns {Promise<import("./result").DatabaseResult<QueryResponse<T>>>} A promise resolving to the query result.
	 */
	query<T = unknown>(
		sql: string,
		params?: QueryParams,
	): Promise<import("./result").DatabaseResult<QueryResponse<T>>>;

	/**
	 * Executes a callback within a database transaction.
	 * @template T The return type of the callback.
	 * @param {() => Promise<import("./result").DatabaseResult<T>>} callback The function to execute within the transaction.
	 * @returns {Promise<import("./result").DatabaseResult<T>>} A promise resolving to the result of the callback.
	 */
	transaction<T>(
		callback: () => Promise<import("./result").DatabaseResult<T>>,
	): Promise<import("./result").DatabaseResult<T>>;

	/**
	 * Disconnects from the database (only useful in 'stateful' mode).
	 * @returns {Promise<void>}
	 */
	disconnect(): Promise<void>;
}
