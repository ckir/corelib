// ts-core/src/loggers/implementations/gcp.ts

import * as gcpConfig from "@google-cloud/pino-logging-gcp-config";
import pino from "pino";
import { type StrictLogger, StrictLoggerWrapper } from "../common";

export default function createGcpLogger(): StrictLogger {
	console.log("[GCP-LOGGER] Initializing GCP specific logger...");
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

		console.log("[GCP-LOGGER] Config created successfully");
		const pinoInstance = pino(config);
		console.log("[GCP-LOGGER] Pino instance created");
		return new StrictLoggerWrapper(pinoInstance);
	} catch (err) {
		console.error("[GCP-LOGGER] ❌ Failed to initialize GCP logger:", err);
		// Fallback to basic JSON logger if GCP config fails to avoid process crash
		const fallback = pino({
			level: process.env.LOG_LEVEL || "info",
			timestamp: pino.stdTimeFunctions.isoTime,
		});
		return new StrictLoggerWrapper(fallback);
	}
}
