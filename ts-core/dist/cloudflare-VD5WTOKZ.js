import {
  getSysInfo
} from "./chunk-P54KRF3I.js";

// src/loggers/implementations/cloudflare.ts
var LEVEL_MAP = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity
};
var CloudflareLogger = class _CloudflareLogger {
  state;
  context;
  _level = process.env.LOG_LEVEL || "info";
  constructor(state = { telemetryEnabled: false }, context = {}) {
    this.state = state;
    this.context = context;
  }
  getTelemetry() {
    return this.state.telemetryEnabled ? getSysInfo() : void 0;
  }
  validate(msg, extras) {
    if (typeof msg !== "string") {
      throw new Error(
        "Logger requires string message first, optional object second"
      );
    }
    if (extras !== void 0 && (typeof extras !== "object" || extras === null || Array.isArray(extras))) {
      throw new Error(
        "Logger requires string message first, optional object second"
      );
    }
  }
  log(level, msg, extras) {
    if ((LEVEL_MAP[level] ?? 30) < this.levelVal) return;
    this.validate(msg, extras);
    const output = {
      level,
      time: Date.now(),
      ...this.context,
      ...extras,
      ...this.state.telemetryEnabled && { telemetry: this.getTelemetry() },
      msg
    };
    console.log(JSON.stringify(output));
  }
  trace(msg, extras) {
    this.log("trace", msg, extras);
  }
  debug(msg, extras) {
    this.log("debug", msg, extras);
  }
  info(msg, extras) {
    this.log("info", msg, extras);
  }
  warn(msg, extras) {
    this.log("warn", msg, extras);
  }
  error(msg, extras) {
    this.log("error", msg, extras);
  }
  fatal(msg, extras) {
    this.log("fatal", msg, extras);
  }
  child(bindings) {
    return new _CloudflareLogger(this.state, { ...this.context, ...bindings });
  }
  setTelemetry(mode) {
    if (mode !== "on" && mode !== "off") {
      throw new Error("setTelemetry accepts only 'on' or 'off'");
    }
    this.state.telemetryEnabled = mode === "on";
  }
  get level() {
    return this._level;
  }
  set level(val) {
    this._level = val;
  }
  get levelVal() {
    return LEVEL_MAP[this._level] ?? 30;
  }
  bindings() {
    return { ...this.context };
  }
  silent() {
    this._level = "silent";
  }
  flush(cb) {
    cb?.();
  }
};
function createCloudflareLogger() {
  return new CloudflareLogger();
}
export {
  createCloudflareLogger as default
};
