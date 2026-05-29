// src/loggers/implementations/browser.ts
var LEVEL_MAP = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity
};
var envLevel = (typeof process !== "undefined" ? process.env?.LOG_LEVEL : void 0) || "info";
var BrowserLogger = class _BrowserLogger {
  ctx;
  // Shared state object so children reflect parent level changes (non-independent).
  state;
  constructor(ctx = {}, state = { level: envLevel }) {
    this.ctx = ctx;
    this.state = state;
  }
  get level() {
    return this.state.level;
  }
  set level(val) {
    this.state.level = val;
  }
  get levelVal() {
    return LEVEL_MAP[this.state.level] ?? 30;
  }
  emit(lvl, consoleFn, msg, extras) {
    if ((LEVEL_MAP[lvl] ?? 30) < this.levelVal) return;
    consoleFn(`[${lvl.toUpperCase()}]`, msg, { ...this.ctx, ...extras });
  }
  trace(msg, extras) {
    this.emit("trace", console.debug.bind(console), msg, extras);
  }
  debug(msg, extras) {
    this.emit("debug", console.debug.bind(console), msg, extras);
  }
  info(msg, extras) {
    this.emit("info", console.info.bind(console), msg, extras);
  }
  warn(msg, extras) {
    this.emit("warn", console.warn.bind(console), msg, extras);
  }
  error(msg, extras) {
    this.emit("error", console.error.bind(console), msg, extras);
  }
  fatal(msg, extras) {
    this.emit("fatal", console.error.bind(console), msg, extras);
  }
  child(bindings) {
    return new _BrowserLogger({ ...this.ctx, ...bindings }, this.state);
  }
  setTelemetry(_mode) {
  }
  bindings() {
    return { ...this.ctx };
  }
  silent() {
    this.state.level = "silent";
  }
  flush(cb) {
    cb?.();
  }
};
var logger = new BrowserLogger();
var browser_default = logger;
export {
  browser_default as logger
};
