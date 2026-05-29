import {
  StrictLoggerWrapper
} from "./chunk-6BGF27YF.js";
import "./chunk-P54KRF3I.js";

// src/loggers/implementations/lambda.ts
import pino from "pino";
import pinoLambda from "pino-lambda";
function createLambdaLogger() {
  const lambdaFnRaw = pinoLambda;
  const lambdaFn = typeof lambdaFnRaw === "function" ? lambdaFnRaw : lambdaFnRaw.default || lambdaFnRaw.pinoLambda;
  let destination;
  if (typeof lambdaFn === "function") {
    try {
      destination = lambdaFn();
    } catch (_e) {
      console.warn("pino-lambda destination creation failed, using default");
    }
  }
  const logger = pino(
    {
      level: process.env.LOG_LEVEL || "info",
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: ["password", "secret", "token", "authorization"]
    },
    destination
  );
  return new StrictLoggerWrapper(logger);
}
export {
  createLambdaLogger as default
};
