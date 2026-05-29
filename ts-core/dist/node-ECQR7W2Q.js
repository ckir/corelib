import {
  StrictLoggerWrapper
} from "./chunk-6BGF27YF.js";
import "./chunk-P54KRF3I.js";

// src/loggers/implementations/node.ts
import { Writable } from "stream";
import pino from "pino";
import pretty from "pino-pretty";
var isPretty = process.env.LOG_PRETTY === "true" || process.env.NODE_ENV !== "production" && process.env.LOG_PRETTY !== "false";
var level = process.env.LOG_LEVEL || "info";
var wsProxy = new Writable({
  write(chunk, _encoding, cb) {
    const fn = globalThis.__wsLogWrite;
    if (fn) fn(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    cb();
  }
});
var dest = pino.multistream([
  {
    level,
    stream: isPretty ? pretty({
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname"
    }) : process.stdout
  },
  { level, stream: wsProxy }
]);
var pinoInstance = pino(
  {
    level,
    redact: ["password", "secret", "token", "authorization", "apiKey"]
  },
  dest
);
var logger = new StrictLoggerWrapper(pinoInstance);
var node_default = logger;
export {
  node_default as default
};
