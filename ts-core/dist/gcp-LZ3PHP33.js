import {
  StrictLoggerWrapper
} from "./chunk-6BGF27YF.js";
import "./chunk-P54KRF3I.js";

// src/loggers/implementations/gcp.ts
import * as gcpConfig from "@google-cloud/pino-logging-gcp-config";
import pino from "pino";
function createGcpLogger() {
  console.log("[GCP-LOGGER] Initializing GCP specific logger...");
  try {
    const configFactory = gcpConfig.createGcpLoggingPinoConfig || gcpConfig.default?.createGcpLoggingPinoConfig || gcpConfig.default;
    if (typeof configFactory !== "function") {
      throw new Error(
        "Could not find createGcpLoggingPinoConfig function in @google-cloud/pino-logging-gcp-config"
      );
    }
    const config = configFactory(
      {},
      // GCP options
      {
        level: process.env.LOG_LEVEL || "info",
        timestamp: pino.stdTimeFunctions.isoTime,
        redact: ["password", "secret", "token", "authorization"]
      }
    );
    console.log("[GCP-LOGGER] Config created successfully");
    const pinoInstance = pino(config);
    console.log("[GCP-LOGGER] Pino instance created");
    return new StrictLoggerWrapper(pinoInstance);
  } catch (err) {
    console.error("[GCP-LOGGER] \u274C Failed to initialize GCP logger:", err);
    const fallback = pino({
      level: process.env.LOG_LEVEL || "info",
      timestamp: pino.stdTimeFunctions.isoTime
    });
    return new StrictLoggerWrapper(fallback);
  }
}
export {
  createGcpLogger as default
};
