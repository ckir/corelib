import type { StrictLogger } from "@ckir/corelib";

/**
 * Environment configuration and variables for the Hono instance.
 */
export type AppEnv = {
	/**
	 * Environment bindings (secrets, keys, config).
	 */
	Bindings: {
		/** URL for the Turso/LibSQL database. */
		CORELIB_TURSO_URL: string;
		/** Auth token for the Turso/LibSQL database. */
		CORELIB_TURSO_TOKEN: string;
		/** Platform identifier (e.g., 'cloudflare', 'aws-lambda'). */
		PLATFORM: string;
	};
	/**
	 * Variables injected into the Hono context.
	 */
	Variables: {
		/** Injected StrictLogger instance. */
		logger: StrictLogger;
		/** Flight-recorder request id, minted per request by the root middleware. */
		rid: number;
	};
};
