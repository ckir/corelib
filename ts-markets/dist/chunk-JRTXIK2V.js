var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../ts-core/src/utils/runtime.ts
function detectRuntime() {
  try {
    if (typeof process !== "undefined" && process.env && process.env.RUNTIME) {
      const envRuntime = process.env.RUNTIME.toLowerCase();
      if ([
        "node",
        "bun",
        "deno",
        "cloudflare",
        "aws-lambda",
        "gcp-cloudrun"
      ].includes(envRuntime)) {
        return envRuntime;
      }
    }
  } catch {
  }
  try {
    if (typeof globalThis !== "undefined" && (!!globalThis.cloudflare || !!globalThis.caches || !!globalThis.WebSocketPair || !!globalThis.__CFW__) || typeof process !== "undefined" && process.env && process.env.PLATFORM === "cloudflare") {
      return "cloudflare";
    }
  } catch {
  }
  try {
    if (typeof process !== "undefined" && process.env && process.env.AWS_LAMBDA_FUNCTION_NAME) {
      return "aws-lambda";
    }
  } catch {
  }
  try {
    if (typeof process !== "undefined" && process.env && (process.env.K_SERVICE || process.env.K_REVISION || process.env.GOOGLE_CLOUD_PROJECT)) {
      return "gcp-cloudrun";
    }
  } catch {
  }
  if (typeof Bun !== "undefined") return "bun";
  if (typeof Deno !== "undefined" && Deno.version && Deno.version.deno) {
    return "deno";
  }
  return "node";
}

export {
  __require,
  __esm,
  __commonJS,
  __export,
  __toESM,
  __toCommonJS,
  detectRuntime
};
