// src/utils/runtime.ts
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

// src/utils/SysInfo.ts
import { createRequire } from "module";
var _require;
var getRequire = () => {
  if (!_require) {
    const runtime = detectRuntime();
    if (typeof import.meta !== "undefined" && import.meta.url) {
      try {
        _require = createRequire(import.meta.url);
      } catch (_e) {
      }
    }
    if (!_require && typeof globalThis.require === "function") {
      _require = globalThis.require;
    }
    if (!_require) {
      _require = (path) => {
        throw new Error(
          `require("${path}") is not available in this runtime (${runtime}).`
        );
      };
    }
  }
  return _require;
};
function redactEnv(env) {
  const redacted = {};
  const secretKeywords = [
    "KEY",
    "SECRET",
    "PASSWORD",
    "TOKEN",
    "AUTH",
    "CREDENTIAL",
    "APIKEY",
    "PRIVATE",
    "CERT",
    "KEYSTORE"
  ];
  for (const [key, value] of Object.entries(env)) {
    if (value === void 0) continue;
    const upperKey = key.toUpperCase();
    const isSecret = secretKeywords.some((k) => upperKey.includes(k));
    redacted[key] = isSecret ? "[REDACTED]" : value;
  }
  return redacted;
}
function fromNodeLike(runtime) {
  const os = getRequire()("node:os");
  const mem = typeof process.memoryUsage === "function" ? process.memoryUsage() : {};
  return {
    /** Current runtime name. */
    runtime,
    /** Operating system platform. */
    os: process.platform,
    /** System architecture. */
    arch: process.arch,
    /** Process ID. */
    pid: process.pid,
    /** Parent process ID. */
    ppid: process.ppid ?? null,
    /** Current working directory. */
    cwd: process.cwd(),
    /** Process uptime in seconds. */
    uptime: process.uptime(),
    /** Operating system version/release. */
    osVersion: os.release?.() ?? null,
    /** System load averages for 1, 5, and 15 minutes. */
    loadAvg: os.loadavg?.() ?? [0, 0, 0],
    /** Memory usage statistics. */
    memory: {
      /** Resident Set Size. */
      rss: mem.rss ?? null,
      /** Total heap size. */
      heapTotal: mem.heapTotal ?? null,
      /** Used heap size. */
      heapUsed: mem.heapUsed ?? null,
      /** Memory used by C++ objects bound to JavaScript objects. */
      external: mem.external ?? null
    },
    /** Redacted environment variables. */
    env: redactEnv({ ...process.env })
  };
}
function fromDeno() {
  const DenoAny = typeof Deno !== "undefined" ? Deno : null;
  const mem = DenoAny && typeof DenoAny.systemMemoryInfo === "function" ? DenoAny.systemMemoryInfo() : {};
  return {
    runtime: "deno",
    os: DenoAny?.build?.os ?? "unknown",
    arch: DenoAny?.build?.arch ?? "unknown",
    pid: DenoAny?.pid ?? null,
    ppid: DenoAny?.ppid ?? null,
    cwd: DenoAny?.cwd?.() ?? "",
    uptime: typeof performance !== "undefined" ? performance.now() / 1e3 : 0,
    osVersion: DenoAny?.osRelease?.() ?? null,
    loadAvg: DenoAny?.loadavg?.() ?? [0, 0, 0],
    memory: {
      rss: mem.total ?? null,
      heapTotal: null,
      heapUsed: null,
      external: null
    },
    env: redactEnv(DenoAny?.env?.toObject() ?? {})
  };
}
function fallback() {
  return {
    runtime: "unknown",
    os: "unknown",
    arch: "unknown",
    pid: null,
    ppid: null,
    cwd: "",
    uptime: 0,
    osVersion: null,
    loadAvg: [0, 0, 0],
    memory: {
      rss: null,
      heapTotal: null,
      heapUsed: null,
      external: null
    },
    env: {}
  };
}
function getSysInfo() {
  const runtime = detectRuntime();
  switch (runtime) {
    case "node":
    case "bun":
      return fromNodeLike(runtime);
    case "deno":
      return fromDeno();
    default:
      return fallback();
  }
}
var SysInfo = {
  /**
   * Gets system information.
   */
  get: getSysInfo
};

export {
  detectRuntime,
  getSysInfo,
  SysInfo
};
