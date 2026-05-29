import {
  detectRuntime
} from "./chunk-P54KRF3I.js";

// src/utils/index.ts
import { createRequire } from "module";

// src/loggers/index.ts
var runtime = detectRuntime();
async function loadLogger() {
  let impl;
  switch (runtime) {
    case "cloudflare":
      impl = await import("./cloudflare-VD5WTOKZ.js");
      break;
    case "aws-lambda":
      impl = await import("./lambda-GNDSXHD2.js");
      break;
    case "gcp-cloudrun":
      impl = await import("./gcp-LZ3PHP33.js");
      break;
    case "bun":
      impl = await import("./bun-LKD6EI6G.js");
      break;
    case "deno":
      impl = await import("./deno-ZFGPOJYX.js");
      break;
    default:
      impl = await import("./node-ECQR7W2Q.js");
      break;
  }
  const loggerRaw = impl.default;
  const logger = typeof loggerRaw === "function" ? loggerRaw() : loggerRaw;
  globalThis.logger = logger;
  return logger;
}
var loggers_default = await loadLogger();

// src/utils/cron.ts
import { Cron } from "croner";
function includeExcludeCron(includeExprs, excludeExprs, handler, timezone) {
  const opts = timezone ? { timezone } : {};
  const job = new Cron("* * * * * *", () => {
    const now = /* @__PURE__ */ new Date();
    const included = includeExprs.some((expr) => {
      const c = new Cron(expr, opts);
      return c.nextRun(now) === null;
    });
    if (!included) return;
    const excluded = excludeExprs.some((expr) => {
      const c = new Cron(expr, opts);
      return c.nextRun(now) === null;
    });
    if (!excluded) {
      handler();
    }
  });
  return job;
}

// src/utils/index.ts
var utilsLogger = loggers_default.child({ section: "Utils" });
var _require;
var getRequire = () => {
  if (!_require) {
    const runtime2 = detectRuntime();
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
          `require("${path}") is not available in this runtime (${runtime2}).`
        );
      };
    }
  }
  return _require;
};
var Utils = {
  /**
   * Logs the current runtime information.
   */
  run: () => utilsLogger.info(`Running on ${detectRuntime()}`)
};
var getEnv = (key) => {
  try {
    if (typeof Deno !== "undefined" && Deno.env) {
      return Deno.env.get(key);
    }
  } catch {
  }
  try {
    if (typeof process !== "undefined" && process.env) {
      return process.env[key];
    }
  } catch {
  }
  return void 0;
};
var getAllEnv = () => {
  try {
    if (typeof Deno !== "undefined" && Deno.env) {
      return Deno.env.toObject();
    }
  } catch {
  }
  try {
    if (typeof process !== "undefined" && process.env) {
      return { ...process.env };
    }
  } catch {
  }
  return {};
};
var readTextFileSync = (file) => {
  if (typeof Deno !== "undefined" && Deno.readTextFileSync) {
    return Deno.readTextFileSync(file);
  }
  const { readFileSync } = getRequire()("node:fs");
  return readFileSync(file, "utf8");
};
var existsSync = (file) => {
  if (typeof Deno !== "undefined" && Deno.statSync) {
    try {
      Deno.statSync(file);
      return true;
    } catch {
      return false;
    }
  }
  const { existsSync: existsSync2 } = getRequire()("node:fs");
  return existsSync2(file);
};
var getCwd = () => {
  if (typeof Deno !== "undefined" && Deno.cwd) {
    return Deno.cwd();
  }
  if (typeof process !== "undefined" && process.cwd) {
    return process.cwd();
  }
  return "/";
};
var getDirname = () => {
  const runtime2 = detectRuntime();
  if (runtime2 === "deno") {
    return new URL(".", import.meta.url).pathname;
  }
  if (typeof import.meta !== "undefined" && import.meta.url) {
    const url = new URL(import.meta.url);
    if (url.protocol === "file:") {
      const { dirname } = getRequire()("node:path");
      const { fileURLToPath } = getRequire()("node:url");
      return dirname(fileURLToPath(import.meta.url));
    }
    const path = url.pathname;
    return path.substring(0, path.lastIndexOf("/"));
  }
  return "";
};
var getPlatform = () => {
  const runtime2 = detectRuntime();
  let plat;
  if (runtime2 === "deno") {
    plat = Deno.build.os;
  } else {
    plat = process.platform;
  }
  return plat === "win32" || plat === "windows" ? "windows" : "linux";
};
var getMode = () => {
  const env = getEnv("NODE_ENV")?.toLowerCase();
  return env === "production" ? "production" : "development";
};
var getTempDir = () => {
  if (detectRuntime() === "deno") {
    return Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
  } else {
    const os = getRequire()("node:os");
    return os.tmpdir();
  }
};
var sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export {
  loggers_default,
  includeExcludeCron,
  getRequire,
  Utils,
  getEnv,
  getAllEnv,
  readTextFileSync,
  existsSync,
  getCwd,
  getDirname,
  getPlatform,
  getMode,
  getTempDir,
  sleep
};
