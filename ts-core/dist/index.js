import {
  ConfigManager,
  RequestResponseSerialize,
  RequestUnlimited,
  endPoint,
  endPoints
} from "./chunk-QVQMVU7B.js";
import {
  Utils,
  existsSync,
  getAllEnv,
  getCwd,
  getDirname,
  getEnv,
  getMode,
  getPlatform,
  getRequire,
  getTempDir,
  includeExcludeCron,
  loggers_default,
  readTextFileSync,
  sleep
} from "./chunk-FQH2PTSD.js";
import {
  SysInfo,
  detectRuntime,
  getSysInfo
} from "./chunk-P54KRF3I.js";

// src/core/index.ts
import { createRequire } from "module";
import { serializeError } from "serialize-error";
var coreLogger = loggers_default.child({ section: "Core" });
var runtime = detectRuntime();
var _require;
var getRequire2 = () => {
  if (!_require) {
    const isNodeLike = [
      "node",
      "bun",
      "deno",
      "aws-lambda",
      "gcp-cloudrun"
    ].includes(runtime);
    if (isNodeLike && typeof import.meta !== "undefined" && import.meta.url) {
      _require = createRequire(import.meta.url);
    } else {
      _require = (path) => {
        throw new Error(
          `require("${path}") is not available in this runtime (${runtime}).`
        );
      };
    }
  }
  return _require;
};
async function loadFFI() {
  if (runtime === "cloudflare") {
    return null;
  }
  const binaryName = "corelib-rust.node";
  const pathsToTry = [];
  let path;
  try {
    path = getRequire2()("node:path");
  } catch {
  }
  if (typeof import.meta !== "undefined" && import.meta.url) {
    try {
      const url = new URL(import.meta.url);
      if (url.protocol === "file:") {
        const { fileURLToPath } = getRequire2()("node:url");
        const moduleFile = fileURLToPath(import.meta.url);
        const moduleDir = path ? path.dirname(moduleFile) : "";
        if (moduleDir && path) {
          pathsToTry.push(
            path.resolve(moduleDir, binaryName),
            path.resolve(moduleDir, "..", binaryName),
            path.resolve(moduleDir, "..", "..", binaryName)
          );
        }
      } else {
        pathsToTry.push(new URL(`./${binaryName}`, import.meta.url).pathname);
      }
    } catch (_e) {
    }
  }
  try {
    const cwd = process.cwd();
    if (path) {
      pathsToTry.push(
        path.resolve(cwd, binaryName),
        // same dir (unlikely but possible)
        path.resolve(cwd, "..", binaryName),
        // parent dir (standard for dist/ -> root)
        path.resolve(cwd, "..", "..", binaryName),
        // grandparent dir (standard for src/core/ -> root)
        path.resolve(cwd, "ts-core", binaryName),
        path.resolve(cwd, "..", "ts-core", binaryName)
      );
    } else {
      pathsToTry.push(`./${binaryName}`, `../${binaryName}`);
    }
  } catch (_e) {
  }
  let libPath;
  try {
    const { existsSync: existsSync2 } = getRequire2()("node:fs");
    libPath = [...new Set(pathsToTry)].find((p) => p && existsSync2(p));
  } catch (_e) {
  }
  if (!libPath) {
    coreLogger.warn(
      `Could not find ${binaryName}. FFI features will be disabled.`
    );
    return null;
  }
  try {
    return getRequire2()(libPath);
  } catch (error) {
    coreLogger.error(`Failed to load FFI from ${libPath}`, {
      error: serializeError(error)
    });
    return null;
  }
}
var coreFFI = await loadFFI();
function isFfiAvailable() {
  return coreFFI !== null;
}
function logAndDouble(msg, value) {
  if (typeof coreFFI === "object" && coreFFI !== null && "logAndDouble" in coreFFI && typeof coreFFI.logAndDouble === "function") {
    return coreFFI.logAndDouble(msg, value);
  }
  throw new Error("FFI not loaded or incompatible");
}
function getVersion() {
  if (typeof coreFFI === "object" && coreFFI !== null && "getVersion" in coreFFI && typeof coreFFI.getVersion === "function") {
    return coreFFI.getVersion();
  }
  throw new Error("FFI not loaded or incompatible");
}
var Core = {
  /**
   * Checks if FFI is available.
   */
  isFfiAvailable,
  /**
   * Gets the native library version.
   */
  getVersion,
  /**
   * Calls the native log and double function.
   */
  logAndDouble,
  /**
   * Runs a core task or simply logs the current runtime status.
   * @param {string} [task] - Optional task name to log.
   * @param {Record<string, unknown>} [options] - Optional options for the task.
   */
  run: (task, options) => {
    coreLogger.info(`Running on ${runtime}. FFI: ${isFfiAvailable()}`);
    if (task) {
      coreLogger.info(`Task: ${task}`, options);
    }
  }
};

// src/database/core/result.ts
import { serializeError as serializeError2 } from "serialize-error";
var wrapSuccess = (value, details) => ({
  status: "success",
  value,
  details
});
var wrapError = (error) => ({
  status: "error",
  reason: serializeError2(error)
});

// src/database/core/transaction-context.ts
import { serializeError as serializeError3 } from "serialize-error";
var transactionLogger = loggers_default.child({ section: "TransactionContext" });
var runtime2 = detectRuntime();
async function loadAsyncLocalStorage() {
  try {
    if (runtime2 === "deno") {
      const { AsyncLocalStorage: AsyncLocalStorage2 } = await import("async_hooks");
      return new AsyncLocalStorage2();
    }
    const { AsyncLocalStorage } = await import("async_hooks");
    return new AsyncLocalStorage();
  } catch (e) {
    transactionLogger.error("Failed to load AsyncLocalStorage", {
      error: serializeError3(e)
    });
    return void 0;
  }
}
var transactionStorage = await loadAsyncLocalStorage();
function getActiveTransaction() {
  return transactionStorage?.getStore();
}
async function runInTransaction(driver, callback) {
  if (!transactionStorage) {
    return callback();
  }
  return transactionStorage.run(driver, callback);
}

// src/database/postgres/postgres-driver.ts
var PostgresDriver = class {
  constructor(config) {
    this.config = config;
  }
  config;
  // Typed after dynamic import; null until connect() is called
  client = null;
  async connect() {
    if (this.client) return;
    const sql = (await import("postgres")).default;
    this.client = sql(this.config.url, {
      max: this.config.maxConnections,
      ssl: this.config.ssl,
      connect_timeout: this.config.timeoutMs ? this.config.timeoutMs / 1e3 : void 0
    });
  }
  async disconnect() {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
  async query(sql, params) {
    try {
      const queryParams = Array.isArray(params) ? params : params ? Object.values(params) : [];
      const client = this.client;
      if (!client) throw new Error("Not connected");
      const res = await client.unsafe(sql, queryParams);
      return wrapSuccess({
        rows: res,
        affectedRows: res.count
      });
    } catch (e) {
      return wrapError(e);
    }
  }
  async prepare(sql) {
    try {
      return wrapSuccess({
        execute: async (params) => {
          try {
            const queryParams = Array.isArray(params) ? params : params ? Object.values(params) : [];
            const prepClient = this.client;
            if (!prepClient) throw new Error("Not connected");
            const res = await prepClient.unsafe(sql, queryParams);
            return wrapSuccess({
              rows: res,
              affectedRows: res.count
            });
          } catch (e) {
            return wrapError(e);
          }
        },
        close: async () => {
        }
      });
    } catch (e) {
      return wrapError(e);
    }
  }
  async beginTransaction() {
    await this.client?.unsafe("BEGIN");
  }
  async commitTransaction() {
    await this.client?.unsafe("COMMIT");
  }
  async rollbackTransaction() {
    await this.client?.unsafe("ROLLBACK");
  }
  async stream(sql, params, onRow) {
    try {
      const queryParams = Array.isArray(params) ? params : params ? Object.values(params) : [];
      const client = this.client;
      if (!client) throw new Error("Not connected");
      for await (const row of client.unsafe(sql, queryParams).cursor()) {
        onRow(row);
      }
      return wrapSuccess(void 0);
    } catch (e) {
      return wrapError(e);
    }
  }
};

// src/database/postgres/postgres-db.ts
var PostgresDb = class {
  constructor(config) {
    this.config = config;
    this.driver = new PostgresDriver(config);
  }
  config;
  driver;
  /**
   * Executes a single SQL query.
   * Joins active transaction if called within a transaction block.
   */
  async query(sql, params) {
    const txDriver = getActiveTransaction();
    const activeDriver = txDriver || this.driver;
    try {
      if (!txDriver) {
        await activeDriver.connect();
      }
      const result = await activeDriver.query(sql, params);
      if (result.status === "error") {
        this.config.logger?.error("Query execution failed", {
          sql,
          reason: result.reason
        });
      }
      return result;
    } catch (e) {
      this.config.logger?.error("Query catastrophic failure", {
        sql,
        error: e
      });
      return wrapError(e);
    } finally {
      if (!txDriver && this.config.mode === "stateless") {
        await activeDriver.disconnect();
      }
    }
  }
  /**
   * Disconnects from the database.
   */
  async disconnect() {
    await this.driver.disconnect();
  }
  /**
   * Executes operations within a transaction using AsyncLocalStorage for context.
   */
  async transaction(callback) {
    const existingDriver = getActiveTransaction();
    const driver = existingDriver || this.driver;
    const isNested = !!existingDriver;
    const savepointName = `sp_${Date.now()}_${Math.floor(Math.random() * 1e3)}`;
    try {
      await driver.connect();
      if (isNested) {
        const spResult = await driver.query(`SAVEPOINT ${savepointName}`);
        if (spResult.status === "error") {
          throw new Error(
            `Failed to create savepoint: ${JSON.stringify(spResult.reason)}`
          );
        }
      } else {
        await driver.beginTransaction();
      }
      return await runInTransaction(driver, async () => {
        const result = await callback();
        if (result.status === "success") {
          if (isNested) {
            await driver.query(`RELEASE SAVEPOINT ${savepointName}`);
          } else {
            await driver.commitTransaction();
          }
        } else {
          this.config.logger?.warn("Transaction rollback initiated", {
            reason: result.reason,
            isNested
          });
          if (isNested) {
            await driver.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          } else {
            await driver.rollbackTransaction();
          }
        }
        return result;
      });
    } catch (e) {
      this.config.logger?.error("Transaction failed due to exception", {
        error: e,
        isNested
      });
      try {
        if (isNested) {
          await driver.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        } else {
          await driver.rollbackTransaction();
        }
      } catch (rollbackErr) {
        this.config.logger?.error("Failed to rollback transaction", {
          error: rollbackErr
        });
      }
      return wrapError(e);
    } finally {
      if (!isNested && this.config.mode === "stateless") {
        await driver.disconnect();
      }
    }
  }
};

// src/database/sqlite/sqlite-driver.ts
var SqliteDriver = class {
  constructor(config) {
    this.config = config;
  }
  config;
  // Typed after dynamic import; null until connect() is called
  client = null;
  async connect() {
    if (this.client) return;
    const { createClient } = await import("@libsql/client");
    this.client = createClient({
      url: this.config.url,
      authToken: this.config.authToken
    });
  }
  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
  async query(sql, params) {
    try {
      if (!this.client) throw new Error("Not connected");
      const res = await this.client.execute({ sql, args: params || [] });
      return wrapSuccess({
        rows: res.rows,
        affectedRows: Number(res.rowsAffected),
        lastInsertId: res.lastInsertRowid?.toString()
      });
    } catch (e) {
      return wrapError(e);
    }
  }
  async prepare(sql) {
    try {
      if (!this.client?.prepare) {
        throw new Error(
          "prepare() is not supported by this @libsql/client instance"
        );
      }
      const stmt = this.client.prepare(sql);
      return wrapSuccess({
        execute: async (params) => {
          try {
            const res = await stmt.execute(params || []);
            return wrapSuccess({
              rows: res.rows,
              affectedRows: Number(res.rowsAffected),
              lastInsertId: res.lastInsertRowid?.toString()
            });
          } catch (e) {
            return wrapError(e);
          }
        },
        close: async () => await stmt.close()
      });
    } catch (e) {
      return wrapError(e);
    }
  }
  async beginTransaction() {
    await this.client?.execute("BEGIN");
  }
  async commitTransaction() {
    await this.client?.execute("COMMIT");
  }
  async rollbackTransaction() {
    await this.client?.execute("ROLLBACK");
  }
  async stream(sql, params, onRow) {
    try {
      if (!this.client?.prepare) {
        throw new Error(
          "stream() via prepare() is not supported by this @libsql/client instance"
        );
      }
      const stmt = this.client.prepare(sql);
      const cursor = await stmt.raw(params || []);
      for (const row of cursor) {
        onRow(row);
      }
      await stmt.close();
      return wrapSuccess(void 0);
    } catch (e) {
      return wrapError(e);
    }
  }
};

// src/database/sqlite/sqlite-db.ts
var SqliteDb = class {
  constructor(config) {
    this.config = config;
    this.driver = new SqliteDriver(config);
  }
  config;
  driver;
  /**
   * Executes a single SQL query.
   * Joins active transaction if called within a transaction block.
   */
  async query(sql, params) {
    const txDriver = getActiveTransaction();
    const activeDriver = txDriver || this.driver;
    try {
      if (!txDriver) {
        await activeDriver.connect();
      }
      const result = await activeDriver.query(sql, params);
      if (result.status === "error") {
        this.config.logger?.error("Query execution failed", {
          sql,
          reason: result.reason
        });
      }
      return result;
    } catch (e) {
      this.config.logger?.error("Query catastrophic failure", {
        sql,
        error: e
      });
      return wrapError(e);
    } finally {
      if (!txDriver && this.config.mode === "stateless") {
        await activeDriver.disconnect();
      }
    }
  }
  /**
   * Disconnects from the database.
   */
  async disconnect() {
    await this.driver.disconnect();
  }
  /**
   * Executes operations within a transaction using AsyncLocalStorage for context.
   */
  async transaction(callback) {
    const existingDriver = getActiveTransaction();
    const driver = existingDriver || this.driver;
    const isNested = !!existingDriver;
    const savepointName = `sp_${Date.now()}_${Math.floor(Math.random() * 1e3)}`;
    try {
      await driver.connect();
      if (isNested) {
        const spResult = await driver.query(`SAVEPOINT ${savepointName}`);
        if (spResult.status === "error") {
          throw new Error(
            `Failed to create savepoint: ${JSON.stringify(spResult.reason)}`
          );
        }
      } else {
        await driver.beginTransaction();
      }
      return await runInTransaction(driver, async () => {
        const result = await callback();
        if (result.status === "success") {
          if (isNested) {
            await driver.query(`RELEASE SAVEPOINT ${savepointName}`);
          } else {
            await driver.commitTransaction();
          }
        } else {
          this.config.logger?.warn("Transaction rollback initiated", {
            reason: result.reason,
            isNested
          });
          if (isNested) {
            await driver.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          } else {
            await driver.rollbackTransaction();
          }
        }
        return result;
      });
    } catch (e) {
      this.config.logger?.error("Transaction failed due to exception", {
        error: e,
        isNested
      });
      try {
        if (isNested) {
          await driver.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        } else {
          await driver.rollbackTransaction();
        }
      } catch (rollbackErr) {
        this.config.logger?.error("Failed to rollback transaction", {
          error: rollbackErr
        });
      }
      return wrapError(e);
    } finally {
      if (!isNested && this.config.mode === "stateless") {
        await driver.disconnect();
      }
    }
  }
};

// src/database/core/errors.ts
import { serializeError as serializeError4 } from "serialize-error";
function handleDbError(logger, message, error) {
  const serialized = serializeError4(error);
  logger.error(message, { error: serialized });
  return serialized;
}

// src/database/index.ts
async function createDatabase(config) {
  if (config.dialect === "postgres") {
    return new PostgresDb(config);
  }
  return new SqliteDb(config);
}
var DatabaseSection = {
  /**
   * Current status of the database section.
   */
  status: "active",
  /**
   * Reference to the default Database implementation (SqliteDb).
   */
  Database: SqliteDb,
  /**
   * Factory function to create a database instance.
   */
  createDatabase
};

// src/retrieve/RequestProxied.ts
import { serializeError as serializeError5 } from "serialize-error";
var requestProxiedLogger = loggers_default.child({ section: "RequestProxied" });
var RequestProxied = class {
  activeProxies;
  failureStreaks = /* @__PURE__ */ new Map();
  currentIndex = 0;
  /**
   * @param proxies - Array of proxy base URLs (e.g. ["https://proxy1...", "https://proxy2..."]).
   *                  At least one proxy is required. The array is cloned internally.
   * @throws Error if no proxies are provided.
   */
  constructor(proxies) {
    if (!Array.isArray(proxies) || proxies.length === 0) {
      throw new Error("RequestProxied: at least one proxy URL is required");
    }
    this.activeProxies = [...proxies];
  }
  /**
   * Builds the final proxy URL using the URL constructor.
   * Guarantees correct query string handling (? vs &) and URL encoding of the original target.
   */
  buildProxyUrl(proxyBase, suffix = "", targetUrl) {
    const baseWithSlash = proxyBase.endsWith("/") ? proxyBase : `${proxyBase}/`;
    const urlObj = new URL(suffix, baseWithSlash);
    const targetStr = typeof targetUrl === "string" ? targetUrl : targetUrl instanceof URL ? targetUrl.toString() : targetUrl.url;
    urlObj.searchParams.set("url", targetStr);
    return urlObj.toString();
  }
  /**
   * Records a successful request for a proxy (resets failure streak).
   */
  trackSuccess(proxyBase) {
    this.failureStreaks.set(proxyBase, 0);
  }
  /**
   * Records a failure for a proxy.
   * After 3 consecutive failures the proxy is permanently removed from the active list for this session.
   */
  trackFailure(proxyBase) {
    const streak = (this.failureStreaks.get(proxyBase) ?? 0) + 1;
    this.failureStreaks.set(proxyBase, streak);
    if (streak >= 3) {
      this.activeProxies = this.activeProxies.filter((p) => p !== proxyBase);
      this.failureStreaks.delete(proxyBase);
      if (this.currentIndex >= this.activeProxies.length) {
        this.currentIndex = 0;
      }
      requestProxiedLogger.warn("Proxy removed after 3 consecutive failures", {
        proxy: proxyBase
      });
    }
  }
  /**
   * Makes a single proxied HTTP request with full fallback.
   *
   * @param url - Original target URL (same as RequestUnlimited).
   * @param suffix - Optional path to append to the proxy base (default "").
   * @param options - Ky options passed through to RequestUnlimited (headers, method, body, etc.).
   */
  async endPoint(url, suffix = "", options = {}) {
    if (this.activeProxies.length === 0) {
      requestProxiedLogger.error("No active proxies left");
      return {
        status: "error",
        reason: serializeError5(new Error("No active proxies left"))
      };
    }
    let attempts = 0;
    const _startIndex = this.currentIndex;
    const targetStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    while (attempts < this.activeProxies.length) {
      const proxyBase = this.activeProxies[this.currentIndex % this.activeProxies.length];
      const proxyUrl = this.buildProxyUrl(proxyBase, suffix, targetStr);
      this.currentIndex = (this.currentIndex + 1) % this.activeProxies.length;
      const result = await endPoint(proxyUrl, options);
      if (result.status === "success") {
        this.trackSuccess(proxyBase);
        return result;
      }
      this.trackFailure(proxyBase);
      attempts++;
    }
    requestProxiedLogger.error("All proxies failed", {
      originalUrl: targetStr
    });
    return {
      status: "error",
      reason: serializeError5(new Error("All proxies failed"))
    };
  }
  /**
   * Makes parallel proxied requests with explicit round-robin load balancing.
   *
   * Each original URL is assigned to a proxy via round-robin.
   * The constructed proxy URLs are then passed to RequestUnlimited.endPoints (parallelism + retries handled there).
   *
   * Note: failure tracking / auto-removal is currently only implemented for endPoint().
   *       endPoints uses the current activeProxies snapshot at call time.
   *
   * @param urls - Array of original target URLs.
   * @param suffix - Optional suffix applied to every proxy (default "").
   * @param options - Ky options applied to all requests.
   */
  async endPoints(urls, suffix = "", options = {}) {
    if (this.activeProxies.length === 0 || urls.length === 0) {
      const noProxiesReason = serializeError5(new Error("No active proxies"));
      return urls.map(() => ({
        status: "error",
        reason: noProxiesReason
      }));
    }
    const proxyUrls = [];
    for (let i = 0; i < urls.length; i++) {
      const proxyBase = this.activeProxies[i % this.activeProxies.length];
      const target = urls[i];
      const targetStr = typeof target === "string" ? target : target instanceof URL ? target.toString() : target.url;
      proxyUrls.push(this.buildProxyUrl(proxyBase, suffix, targetStr));
    }
    return await endPoints(proxyUrls, options);
  }
};

// src/retrieve/index.ts
var retrieveLogger = loggers_default.child({ section: "Retrieve" });
var Retrieve = {
  run: () => retrieveLogger.info(`Running on ${detectRuntime()}`)
};
export {
  ConfigManager,
  Core,
  DatabaseSection,
  PostgresDb,
  PostgresDriver,
  RequestProxied,
  RequestResponseSerialize,
  RequestUnlimited,
  Retrieve,
  SqliteDb,
  SqliteDriver,
  SysInfo,
  Utils,
  coreFFI,
  createDatabase,
  detectRuntime,
  endPoint,
  endPoints,
  existsSync,
  getActiveTransaction,
  getAllEnv,
  getCwd,
  getDirname,
  getEnv,
  getMode,
  getPlatform,
  getRequire,
  getSysInfo,
  getTempDir,
  getVersion,
  handleDbError,
  includeExcludeCron,
  isFfiAvailable,
  logAndDouble,
  loggers_default as logger,
  readTextFileSync,
  runInTransaction,
  sleep,
  transactionStorage,
  wrapError,
  wrapSuccess
};
