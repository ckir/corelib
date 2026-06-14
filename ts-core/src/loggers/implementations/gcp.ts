// ts-core/src/loggers/implementations/gcp.ts

import * as gcpConfig from "@google-cloud/pino-logging-gcp-config";
import pino from "pino";
import { type StrictLogger, StrictLoggerWrapper } from "../common";

export default function createGcpLogger(): StrictLogger {
	try {
		// Dynamically access the config factory to handle both ESM and CJS shapes
		const configFactory =
			(gcpConfig as any).createGcpLoggingPinoConfig ||
			(gcpConfig as any).default?.createGcpLoggingPinoConfig ||
			(gcpConfig as any).default;

		if (typeof configFactory !== "function") {
			throw new Error(
				"Could not find createGcpLoggingPinoConfig function in @google-cloud/pino-logging-gcp-config",
			);
		}

		const config = configFactory(
			{}, // GCP options
			{
				level: process.env.LOG_LEVEL || "info",
				timestamp: pino.stdTimeFunctions.isoTime,
				redact: ["password", "secret", "token", "authorization"],
			},
		);

		const pinoInstance = pino(config);
		return new StrictLoggerWrapper(pinoInstance);
	} catch (err) {
		// Bootstrap fallback: the structured logger itself failed to init, so console
		// is the only available sink. We then degrade to a basic pino logger (below).
		console.error("[GCP-LOGGER] Failed to initialize GCP logger:", err);
		// Fallback to basic JSON logger if GCP config fails to avoid process crash
		const fallback = pino({
			level: process.env.LOG_LEVEL || "info",
			timestamp: pino.stdTimeFunctions.isoTime,
		});
		return new StrictLoggerWrapper(fallback);
	}
}
