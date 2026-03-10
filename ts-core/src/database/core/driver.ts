import type { DatabaseResult } from "./result.js";
import type { QueryParams, QueryResponse } from "./types.js";

/**
 * Interface for prepared statements in the driver.
 */
export interface PreparedDriverStatement {
	execute<T = any>(
		params?: QueryParams,
	): Promise<DatabaseResult<QueryResponse<T>>>;
	close(): Promise<void>;
}

/**
 * Core interface for database drivers. All dialects must implement this.
 */
export interface DbDriver {
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	query<T = any>(
		sql: string,
		params?: QueryParams,
	): Promise<DatabaseResult<QueryResponse<T>>>;
	prepare(sql: string): Promise<DatabaseResult<PreparedDriverStatement>>;
	beginTransaction(): Promise<void>;
	commitTransaction(): Promise<void>;
	rollbackTransaction(): Promise<void>;
	stream<T = any>(
		sql: string,
		params: QueryParams,
		onRow: (row: T) => void,
	): Promise<DatabaseResult<void>>;
}
