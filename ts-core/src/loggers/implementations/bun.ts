// =============================================
// FILE: ts-core/src/loggers/implementations/bun.ts
// PURPOSE: Bun-specific logger implementation - loads common (pino)
// =============================================

import pino from "pino";
import { type StrictLogger, StrictLoggerWrapper } from "../common";

const isPretty =
	process.env.LOG_PRETTY === "true" ||
	(process.env.NODE_ENV !== "production" && process.env.LOG_PRETTY !== "false");

const pinoInstance = pino({
	level: process.env.LOG_LEVEL || "info",
	transport: isPretty
		? {
				target: "pino-pretty",
				options: {
					colorize: true,
					translateTime: "SYS:standard",
					ignore: "pid,hostname",
				},
			}
		: undefined,
	redact: ["password", "secret", "token", "authorization", "apiKey"],
});

const logger: StrictLogger = new StrictLoggerWrapper(pinoInstance);

export default logger;
