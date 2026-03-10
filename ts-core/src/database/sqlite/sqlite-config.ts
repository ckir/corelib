import type { BaseDbConfig } from "../core/types";

/**
 * Configuration for SQLite dialect.
 */
export interface SqliteConfig extends BaseDbConfig {
	dialect: "sqlite";
	authToken?: string;
	localPath?: string;
	maxConnections?: number;
}
