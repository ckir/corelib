import {
  SysInfo
} from "./chunk-P54KRF3I.js";

// src/loggers/common/index.ts
var TELEMETRY_CACHE_TTL_MS = 5e3;
var StrictLoggerWrapper = class _StrictLoggerWrapper {
  pinoInstance;
  state;
  context;
  telemetryCache = null;
  constructor(pinoInstance, state = { telemetryEnabled: false }, context = {}) {
    this.pinoInstance = pinoInstance;
    this.state = state;
    this.context = context;
  }
  getTelemetry() {
    if (!this.state.telemetryEnabled) return void 0;
    const now = Date.now();
    if (!this.telemetryCache || now >= this.telemetryCache.expiresAt) {
      this.telemetryCache = {
        value: SysInfo.get(),
        expiresAt: now + TELEMETRY_CACHE_TTL_MS
      };
    }
    return this.telemetryCache.value;
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
  trace(msg, extras) {
    this.validate(msg, extras);
    this.pinoInstance.trace(
      { ...this.context, ...extras, telemetry: this.getTelemetry() },
      msg
    );
  }
  debug(msg, extras) {
    this.validate(msg, extras);
    this.pinoInstance.debug(
      { ...this.context, ...extras, telemetry: this.getTelemetry() },
      msg
    );
  }
  info(msg, extras) {
    this.validate(msg, extras);
    this.pinoInstance.info(
      { ...this.context, ...extras, telemetry: this.getTelemetry() },
      msg
    );
  }
  warn(msg, extras) {
    this.validate(msg, extras);
    this.pinoInstance.warn(
      { ...this.context, ...extras, telemetry: this.getTelemetry() },
      msg
    );
  }
  error(msg, extras) {
    this.validate(msg, extras);
    this.pinoInstance.error(
      { ...this.context, ...extras, telemetry: this.getTelemetry() },
      msg
    );
  }
  fatal(msg, extras) {
    this.validate(msg, extras);
    this.pinoInstance.fatal(
      { ...this.context, ...extras, telemetry: this.getTelemetry() },
      msg
    );
  }
  child(bindings) {
    return new _StrictLoggerWrapper(this.pinoInstance, this.state, {
      ...this.context,
      ...bindings
    });
  }
  setTelemetry(mode) {
    if (mode !== "on" && mode !== "off") {
      throw new Error("setTelemetry accepts only 'on' or 'off'");
    }
    this.state.telemetryEnabled = mode === "on";
  }
  get level() {
    return this.pinoInstance.level;
  }
  set level(val) {
    this.pinoInstance.level = val;
  }
  get levelVal() {
    return this.pinoInstance.levelVal;
  }
  bindings() {
    return { ...this.context };
  }
  silent() {
    this.pinoInstance.level = "silent";
  }
  flush(cb) {
    if (typeof this.pinoInstance.flush === "function") {
      this.pinoInstance.flush(cb);
    } else {
      cb?.();
    }
  }
};

export {
  StrictLoggerWrapper
};
