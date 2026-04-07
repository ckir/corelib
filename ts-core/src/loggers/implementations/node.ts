// =============================================
// FILE: ts-core/src/loggers/implementations/node.ts
// PURPOSE: Node-specific logger implementation – loads common (pino)
// =============================================

import pino from "pino";
import { type StrictLogger, StrictLoggerWrapper } from "../common";

const pinoInstance = pino({
	level: process.env.LOG_LEVEL || "info",
	transport: {
		target: "pino-pretty",
		options: {
			colorize: true,
			translateTime: "SYS:standard",
			ignore: "pid,hostname",
		},
	},
	redact: ["password", "secret", "token", "authorization", "apiKey"],
});

const logger: StrictLogger = new StrictLoggerWrapper(pinoInstance);

export default logger;
