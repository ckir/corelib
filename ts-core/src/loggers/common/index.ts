// =============================================
// FILE: ts-core/src/loggers/common/index.ts
// PURPOSE: Common logger setup using pino with transports
// FIXED: Augmented global types here as well for consistency, but since the declaration is global,
//        it can be in any file; included here to ensure visibility in common module.
// NEW FIXES (2026-03-05):
//   • Added root logger level configuration to respect process.env.LOG_LEVEL (from .env)
//     - Defaults to 'info' if LOG_LEVEL not set
//     - Ensures all levels (including trace/debug) are logged if LOG_LEVEL=trace or debug
//     - User apps must load .env (e.g., import 'dotenv/config') to apply custom LOG_LEVEL
// FIXED (2026-03-06): Changed bare 'logger =' to 'globalThis.logger =' to avoid ReferenceError in strict mode/ESM.
//                     This ensures the global variable is properly assigned at runtime while maintaining type safety.
// =============================================

import type { Logger } from "pino";
import pino from "pino";

declare global {
	var logger: Logger | undefined;
}

const transport = pino.transport({
	targets: [
		{
			level: "trace",
			target: "pino-pretty",
		},
		// {
		//     target: 'pino-socket',
		//     options: {
		//         address: '127.0.0.1',
		//         port: 9000,
		//         mode: 'tcp',
		//         reconnect: true,
		//     },
		// }
	],
});

globalThis.logger = pino({ level: process.env.LOG_LEVEL || "info" }, transport);

export default globalThis.logger;
