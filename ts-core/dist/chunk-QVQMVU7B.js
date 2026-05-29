import {
  existsSync,
  getAllEnv,
  getCwd,
  getDirname,
  getMode,
  getPlatform,
  getRequire,
  loggers_default,
  readTextFileSync
} from "./chunk-FQH2PTSD.js";
import {
  detectRuntime
} from "./chunk-P54KRF3I.js";

// src/retrieve/RequestUnlimited.ts
import { deepmergeCustom as deepmergeCustom2 } from "deepmerge-ts";
import ky, { HTTPError } from "ky";
import { serializeError as serializeError3 } from "serialize-error";

// src/configs/ConfigManager.ts
import { EventEmitter } from "events";
import { Command } from "commander";
import { deepmergeCustom } from "deepmerge-ts";
import { serializeError } from "serialize-error";

// src/configs/ConfigManager.json
var ConfigManager_default = {
  markets: {
    chromeVersion: "146",
    nasdaq: {
      statusEndpoint: "https://api.nasdaq.com/api/market-info",
      monitor: {
        liveIntervalSec: 10,
        closedIntervalSec: 3600,
        warnIntervalSec: 60
      },
      symbols: {
        nasdaqListedUrl: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt",
        otherListedUrl: "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt",
        initialBackoffMs: 1e3,
        maxRetryBackoffMs: 36e5,
        maxFetchRetries: 10
      },
      quotes: {
        concurrencyLimit: 5
      }
    }
  },
  retrieve: {
    timeout: 5e4,
    retry: {
      limit: 5,
      backoffLimit: 3e3
    }
  }
};

// src/configs/ConfigUtils.ts
import crypto from "crypto";
async function decryptConfig(encryptedData) {
  const { getEnv } = await import("./utils-WZ2RB7RU.js");
  const password = getEnv("CORELIB_AES_PASSWORD");
  if (!password) {
    throw new Error(
      "Decryption failed: CORELIB_AES_PASSWORD environment variable is not set."
    );
  }
  const lines = encryptedData.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error(
      "Invalid .enc file format. Expected IV on line 1 and Ciphertext on line 2."
    );
  }
  const iv = Buffer.from(lines[0], "base64");
  const ciphertext = Buffer.from(lines[1], "base64");
  const key = Buffer.from(password, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

// src/configs/ConfigManager.ts
var leafMerger = deepmergeCustom({
  mergeArrays: false
});
var ConfigManager = class _ConfigManager extends EventEmitter {
  static instance;
  _config = {};
  _defaultsPath;
  static _logger = loggers_default.child({ section: "ConfigManager" });
  constructor() {
    super();
    const __dirname = getDirname();
    let defaultsPath = __dirname;
    try {
      const { join } = getRequire()("node:path");
      defaultsPath = join(__dirname, "ConfigManager.json");
    } catch (_e) {
      defaultsPath = `${__dirname}/ConfigManager.json`;
    }
    this._defaultsPath = defaultsPath;
    if (!globalThis.sysconfig) {
      globalThis.sysconfig = this._config;
    }
  }
  /**
   * Singleton accessor for the ConfigManager
   */
  static getInstance() {
    if (!_ConfigManager.instance) {
      _ConfigManager.instance = new _ConfigManager();
    }
    return _ConfigManager.instance;
  }
  /**
   * Retrieves a nested configuration value by string path (e.g., "db.mysql.port").
   * @param {string} path - The dot-notation path to the configuration value.
   * @returns The value at the specified path, or undefined if not found.
   */
  get(path) {
    const keys = path.split(".");
    let current = this._config;
    for (const key of keys) {
      if (current === null || typeof current !== "object" || !(key in current)) {
        return void 0;
      }
      current = current[key];
    }
    return current;
  }
  /**
   * Static helper to retrieve a configuration value from the singleton instance.
   */
  static get(path) {
    return _ConfigManager.getInstance().get(path);
  }
  /**
   * Main initialization sequence.
   * 1. Load Defaults
   * 2. Detect CLI -C flag for external config
   * 3. Process Hierarchy (commonAll -> app -> platform -> mode)
   * 4. Apply Env Overrides
   * 5. Apply CLI Overrides
   */
  async initialize() {
    this.loadDefaults();
    const args = process.argv.slice(2);
    const program = new Command();
    program.option("-C, --config <path>", "external config file or URL");
    program.allowUnknownOption(true);
    program.helpOption(false);
    await program.parseAsync(args, { from: "user" });
    const configPath = program.opts().config;
    if (configPath) {
      const externalData = await this.fetchExternalConfig(configPath);
      this.processHierarchy(externalData);
    }
    this.applyEnvOverrides();
    await this.applyCliOverrides(program);
    globalThis.sysconfig = this._config;
    this.emit("initialized", this._config);
  }
  /**
   * Retrieves the current active configuration object.
   */
  getConfig() {
    return this._config;
  }
  /**
   * Public method to load and merge a new configuration from a URL or file path on demand.
   * Respects the established configuration hierarchy and maintains Env overrides.
   * @param source - The URL or local file path to the configuration.
   */
  async loadExternalConfig(source) {
    try {
      const externalData = await this.fetchExternalConfig(source);
      this.processHierarchy(externalData);
      this.applyEnvOverrides();
      globalThis.sysconfig = this._config;
      this.emit("configLoaded", this._config);
    } catch (error) {
      this.logError(
        `Failed to load external config dynamically from ${source}`,
        error
      );
      throw error;
    }
  }
  /**
   * Loads the base ConfigManager.json from the local directory.
   * Always seeds from the bundled JSON (available in all runtimes, including edge).
   * If the JSON file is also found on disk, it replaces the bundled defaults.
   */
  loadDefaults() {
    this._config = {
      ...ConfigManager_default
    };
    if (existsSync(this._defaultsPath)) {
      try {
        const raw = readTextFileSync(this._defaultsPath);
        this._config = JSON.parse(raw);
      } catch (e) {
        this.logError("Failed to load defaults", e);
      }
    }
  }
  /**
   * Fetches and parses configuration from a URL or Local Path.
   * Supports .enc decryption and dynamic confbox parsing by extension.
   */
  async fetchExternalConfig(source) {
    let content;
    if (source.startsWith("http")) {
      const { endPoint: endPoint2 } = await import("./RequestUnlimited-3SLGSZOD.js");
      const result = await endPoint2(source);
      if (result.status === "error") {
        throw new Error("Failed to fetch external config");
      }
      content = result.value.body;
    } else {
      content = readTextFileSync(source);
    }
    const lowerSource = source.toLowerCase();
    if (lowerSource.endsWith(".enc")) {
      return this.validateConfigObject(await decryptConfig(content), source);
    }
    const confbox = await import("confbox");
    if (lowerSource.endsWith(".yaml") || lowerSource.endsWith(".yml")) {
      return this.validateConfigObject(confbox.parseYAML(content), source);
    }
    if (lowerSource.endsWith(".toml")) {
      return this.validateConfigObject(confbox.parseTOML(content), source);
    }
    if (lowerSource.endsWith(".json5")) {
      return this.validateConfigObject(confbox.parseJSON5(content), source);
    }
    if (lowerSource.endsWith(".jsonc")) {
      return this.validateConfigObject(confbox.parseJSONC(content), source);
    }
    if (lowerSource.endsWith(".ini")) {
      return this.validateConfigObject(confbox.parseINI(content), source);
    }
    return this.validateConfigObject(confbox.parseJSON(content), source);
  }
  validateConfigObject(parsed, source) {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `Config from "${source}" must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`
      );
    }
    return parsed;
  }
  /**
   * Processes the specific hierarchy:
   * commonAll -> [AppName].common -> [AppName].[platform] -> [AppName].[platform].[mode]
   */
  processHierarchy(data) {
    if (!data) return;
    const appName = this.getAppName();
    const platform = getPlatform();
    const mode = getMode();
    let layeredConfig = data.commonAll || {};
    const appKey = Object.keys(data).find(
      (k) => k.toLowerCase() === appName.toLowerCase()
    );
    const appSection = appKey ? data[appKey] : null;
    if (appSection) {
      if (appSection.common) {
        layeredConfig = leafMerger(
          layeredConfig,
          appSection.common
        );
      }
      const platformSection = appSection[platform];
      if (platformSection) {
        const modeSection = platformSection[mode];
        if (modeSection) {
          layeredConfig = leafMerger(layeredConfig, modeSection);
        }
      }
    }
    this._config = leafMerger(this._config, layeredConfig);
  }
  /**
   * Maps CORELIB_ prefixed environment variables to config keys.
   * Example: CORELIB_DB_PORT -> config.db.port
   */
  applyEnvOverrides() {
    const prefix = "CORELIB_";
    const env = getAllEnv();
    Object.keys(env).forEach((envKey) => {
      if (envKey.startsWith(prefix)) {
        const configPath = envKey.slice(prefix.length).toLowerCase().replace(/_/g, ".");
        const value = this.parseValue(env[envKey]);
        this.setPath(this._config, configPath, value);
      }
    });
  }
  /**
   * Maps Kebab-case CLI arguments to the config structure.
   */
  async applyCliOverrides(program) {
    const overrides = {};
    let i = 0;
    while (i < program.args.length) {
      const arg = program.args[i];
      if (arg.startsWith("--")) {
        let key = arg.slice(2);
        let value;
        const eqIdx = key.indexOf("=");
        if (eqIdx > -1) {
          value = key.slice(eqIdx + 1);
          key = key.slice(0, eqIdx);
        } else {
          i++;
          value = i < program.args.length ? program.args[i] : true;
        }
        overrides[key] = value;
      }
      i++;
    }
    Object.keys(overrides).forEach((key) => {
      if (key === "config") return;
      const configPath = key.replace(/-/g, ".");
      const value = this.parseValue(overrides[key]);
      this.updateValue(configPath, value);
    });
  }
  /**
   * Core update method that updates both the local object
   * and the active globalThis object, then emits events.
   */
  updateValue(path, value) {
    this.setPath(this._config, path, value);
    this.emit("change", { path, value });
    this.emit(`change:${path}`, value);
  }
  /**
   * Helper to set nested object values by string path (e.g., "db.mysql.port")
   */
  setPath(obj, path, value) {
    const keys = path.split(".");
    let current = obj;
    while (keys.length > 1) {
      const key = keys.shift();
      if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
        current[key] = {};
      }
      current = current[key];
    }
    current[keys[0]] = value;
  }
  /**
   * Parses values from Env/CLI, automatically handling JSON strings for arrays/objects.
   */
  parseValue(val) {
    if (typeof val !== "string") return val;
    if (val.startsWith("[") && val.endsWith("]") || val.startsWith("{") && val.endsWith("}")) {
      try {
        return JSON.parse(val);
      } catch (e) {
        this.logError("Failed to parse complex JSON from CLI/Env flag", e);
        return val;
      }
    }
    if (val.toLowerCase() === "true") return true;
    if (val.toLowerCase() === "false") return false;
    if (!Number.isNaN(Number(val)) && val.trim() !== "") return Number(val);
    return val;
  }
  getAppName() {
    try {
      const runtime = detectRuntime();
      if (runtime === "node" || runtime === "bun" || typeof import.meta !== "undefined" && import.meta.url && import.meta.url.startsWith("file:")) {
        const { basename } = getRequire()("node:path");
        return basename(getCwd());
      }
      return "edge-app";
    } catch (e) {
      this.logError(
        "Failed to get app name from cwd. Falling back to default-app",
        e
      );
      return "default-app";
    }
  }
  /**
   * Logs errors internally. If the global pino logger is available, it uses it
   * along with `serialize-error` to structure the error object for Vector sidecars.
   */
  logError(msg, error) {
    const serialized = error ? serializeError(error) : void 0;
    _ConfigManager._logger.error(msg, { error: serialized });
  }
  // --- Rust Integration Helpers ---
  toJsonString() {
    return JSON.stringify(this._config);
  }
  toBuffer() {
    return Buffer.from(this.toJsonString());
  }
};

// src/retrieve/RequestResponseSerialize.ts
import { serializeError as serializeError2 } from "serialize-error";
var requestResponseSerializeLogger = loggers_default.child({
  section: "RequestResponseSerialize"
});
async function serializeResponse(response) {
  if (!response) return null;
  const headers = {};
  response.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  let body;
  const contentType = response.headers.get("content-type") || "";
  try {
    if (response.bodyUsed) {
      body = "[Body already consumed]";
    } else {
      const rawText = await response.clone().text();
      if (contentType.includes("application/json")) {
        try {
          body = JSON.parse(rawText);
        } catch {
          body = rawText;
        }
      } else {
        body = rawText;
      }
    }
  } catch (error) {
    requestResponseSerializeLogger.warn("Failed to read response body", {
      status: response.status,
      url: response.url,
      bodyUsed: response.bodyUsed,
      error: serializeError2(error)
    });
    body = "[Error reading body]";
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers,
    url: response.url,
    redirected: response.redirected,
    type: response.type,
    body
  };
}
var RequestResponseSerialize = {
  serialize: serializeResponse
};

// src/retrieve/RequestUnlimited.ts
var requestUnlimitedLogger = loggers_default.child({ section: "RequestUnlimited" });
var customDeepmerge = deepmergeCustom2({
  mergeArrays: false
});
var DEFAULT_REQUEST_OPTIONS = {
  timeout: 5e4,
  throwHttpErrors: true,
  retry: {
    limit: 5,
    methods: ["get", "post", "put", "delete", "patch"],
    backoffLimit: 3e3,
    shouldRetry: ({ error, retryCount }) => {
      if (error instanceof HTTPError && error.response) {
        const status = error.response.status;
        if (status === 429 && retryCount <= 5) return true;
        if (status >= 400 && status < 500) return false;
        return status >= 500;
      }
      return true;
    }
  },
  method: "get",
  headers: {
    "content-type": "application/json",
    accept: "application/json"
  },
  hooks: {
    beforeRetry: [
      async ({ retryCount }) => {
        requestUnlimitedLogger.trace("Retrying API call", { retryCount });
      }
    ]
  }
};
function toLowercaseKeys(obj) {
  const newObj = {};
  for (const key in obj) {
    if (Object.hasOwn(obj, key) && obj[key] !== void 0) {
      newObj[key.toLowerCase()] = obj[key];
    }
  }
  return newObj;
}
async function endPoint(url, options = {}) {
  const normalizedDefaultHeaders = toLowercaseKeys(
    DEFAULT_REQUEST_OPTIONS.headers || {}
  );
  const normalizedInputHeaders = options.headers ? toLowercaseKeys(options.headers) : {};
  const { headers, hooks, ...remainingOptions } = options;
  const cfgTimeout = ConfigManager.get("retrieve.timeout") ?? 5e4;
  const cfgRetryLimit = ConfigManager.get("retrieve.retry.limit") ?? 5;
  const cfgBackoffLimit = ConfigManager.get("retrieve.retry.backoffLimit") ?? 3e3;
  const defaultRetry = DEFAULT_REQUEST_OPTIONS.retry;
  const kyOptions = customDeepmerge(
    DEFAULT_REQUEST_OPTIONS,
    {
      timeout: cfgTimeout,
      retry: {
        ...defaultRetry,
        limit: cfgRetryLimit,
        backoffLimit: cfgBackoffLimit
      }
    },
    remainingOptions,
    {
      headers: { ...normalizedDefaultHeaders, ...normalizedInputHeaders },
      hooks: {
        beforeRetry: [
          ...DEFAULT_REQUEST_OPTIONS.hooks?.beforeRetry || [],
          ...hooks?.beforeRetry || []
        ]
      }
    }
  );
  try {
    const responseObject = await ky(url, kyOptions);
    const response = await serializeResponse(responseObject);
    return {
      status: "success",
      value: response
    };
  } catch (error) {
    if (error instanceof HTTPError || error.response) {
      const errorResponse = await serializeResponse(
        // @ts-expect-error - ky error property
        error.response
      );
      requestUnlimitedLogger.warn("HTTP Error", {
        status: errorResponse?.status,
        url: url.toString()
      });
      return {
        status: "error",
        reason: errorResponse
      };
    }
    const serializedError = serializeError3(error);
    requestUnlimitedLogger.error("Internal/Network Error", {
      error: serializedError
    });
    return {
      status: "error",
      reason: serializedError
    };
  }
}
async function endPoints(urls, options = {}) {
  const promises = urls.map((url) => endPoint(url, options));
  const results = await Promise.allSettled(promises);
  return results.map((result) => {
    if (result.status === "fulfilled") return result.value;
    return {
      status: "error",
      reason: serializeError3(result.reason)
    };
  });
}
var RequestUnlimited = {
  defaults: DEFAULT_REQUEST_OPTIONS,
  endPoint,
  endPoints
};

export {
  RequestResponseSerialize,
  DEFAULT_REQUEST_OPTIONS,
  endPoint,
  endPoints,
  RequestUnlimited,
  ConfigManager
};
