import type { BaseDbConfig } from "../core/types";

/**
 * Configuration for SQLite dialect.
 */
export interface SqliteConfig extends BaseDbConfig {
	dialect: "sqlite";
	authToken?: string;
	localPath?: string;
	maxConnections?: number;
	/**
	 * Opt-in SQLite journal mode. When set on a local-file url, connect() issues
	 * `PRAGMA journal_mode=<value>` immediately after opening the connection.
	 * Has no effect on remote libsql (Turso) urls.
	 * Default: undefined (no PRAGMA issued — preserves existing behavior).
	 */
	journalMode?: "WAL" | "DELETE";
	/**
	 * Opt-in SQLite synchronous mode. Issued as `PRAGMA synchronous=<value>` when
	 * `journalMode` is also set and the url is a local file.
	 * "NORMAL" cuts per-commit fsync cost (~120ms → ~1-5ms for WAL appends).
	 * Default: undefined (no PRAGMA issued).
	 */
	synchronous?: "NORMAL" | "FULL";
}
