import type { DatabaseResult } from "./result.js";
import type { QueryParams, QueryResponse } from "./types.js";

/**
 * Interface for prepared statements in the driver.
 * Prepared statements are pre-compiled SQL queries that can be executed multiple times with different parameters.
 */
export interface PreparedDriverStatement {
	/**
	 * Executes the prepared statement with the given parameters.
	 * @template T The expected type of the rows in the result.
	 * @param {QueryParams} [params] Optional parameters for the query.
	 * @returns {Promise<DatabaseResult<QueryResponse<T>>>} A promise resolving to the database result.
	 */
	execute<T = unknown>(
		params?: QueryParams,
	): Promise<DatabaseResult<QueryResponse<T>>>;

	/**
	 * Closes the prepared statement and releases associated resources.
	 * @returns {Promise<void>}
	 */
	close(): Promise<void>;
}

/**
 * Core interface for database drivers. All dialect-specific drivers (Postgres, SQLite, etc.) must implement this.
 * This ensures a consistent API for database operations across different storage engines.
 */
export interface DbDriver {
	/**
	 * Establishes a connection to the database.
	 * @returns {Promise<void>}
	 */
	connect(): Promise<void>;

	/**
	 * Closes the connection to the database.
	 * @returns {Promise<void>}
	 */
	disconnect(): Promise<void>;

	/**
	 * Executes a one-off SQL query.
	 * @template T The expected type of the rows in the result.
	 * @param {string} sql The SQL query string.
	 * @param {QueryParams} [params] Optional parameters for the query.
	 * @returns {Promise<DatabaseResult<QueryResponse<T>>>} A promise resolving to the database result.
	 */
	query<T = unknown>(
		sql: string,
		params?: QueryParams,
	): Promise<DatabaseResult<QueryResponse<T>>>;

	/**
	 * Prepares an SQL query for execution.
	 * @param {string} sql The SQL query string to prepare.
	 * @returns {Promise<DatabaseResult<PreparedDriverStatement>>} A promise resolving to the prepared statement.
	 */
	prepare(sql: string): Promise<DatabaseResult<PreparedDriverStatement>>;

	/**
	 * Begins a new database transaction.
	 * @returns {Promise<void>}
	 */
	beginTransaction(): Promise<void>;

	/**
	 * Commits the current database transaction.
	 * @returns {Promise<void>}
	 */
	commitTransaction(): Promise<void>;

	/**
	 * Rolls back the current database transaction.
	 * @returns {Promise<void>}
	 */
	rollbackTransaction(): Promise<void>;

	/**
	 * Streams the results of an SQL query row by row.
	 * @template T The expected type of each row.
	 * @param {string} sql The SQL query string.
	 * @param {QueryParams} params Parameters for the query.
	 * @param {(row: T) => void} onRow Callback function called for each row.
	 * @returns {Promise<DatabaseResult<void>>} A promise that resolves when the stream finishes.
	 */
	stream<T = unknown>(
		sql: string,
		params: QueryParams,
		onRow: (row: T) => void,
	): Promise<DatabaseResult<void>>;
}
