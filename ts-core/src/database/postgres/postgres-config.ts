import type { BaseDbConfig } from "../core/types";

/**
 * Configuration for Postgres dialect.
 */
export interface PostgresConfig extends BaseDbConfig {
	dialect: "postgres";
	maxConnections?: number;
	ssl?:
		| boolean
		| {
				rejectUnauthorized?: boolean;
				ca?: string;
				key?: string;
				cert?: string;
		  };
}
