import type { StrictLogger } from "@ckir/corelib";

/**
 * Environment configuration and variables for the Hono instance.
 */
export type AppEnv = {
	Bindings: {
		CORELIB_TURSO_URL: string;
		CORELIB_TURSO_TOKEN: string;
		PLATFORM: string;
	};
	Variables: {
		logger: StrictLogger;
	};
};
