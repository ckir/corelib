// =============================================
// FILE: ts-core/src/loggers/common/index.ts
// PURPOSE: Common logger setup using pino with transports
// FIXED: Augmented global types here as well for consistency, but since the declaration is global,
//        it can be in any file; included here to ensure visibility in common module.
// =============================================

import pino from "pino";
import type { Logger } from "pino";

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

export const Loggers = {
	// We use the transport for high-performance non-blocking logs
	logger: pino(transport),
};

globalThis.logger = Loggers.logger;
