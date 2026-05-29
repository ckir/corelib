import {
  detectRuntime
} from "./chunk-JRTXIK2V.js";

// src/nasdaq/ApiNasdaqQuotes.ts
import {
  ConfigManager as ConfigManager3,
  RequestProxied
} from "@ckir/corelib";

// src/nasdaq/ApiNasdaqUnlimited.ts
import {
  ConfigManager,
  endPoint,
  logger
} from "@ckir/corelib";
import { serializeError } from "serialize-error";
var nasdaqUnlimitedLogger = logger.child({ section: "ApiNasdaqUnlimited" });
function apiErrorToString(status) {
  if (!status.bCodeMessage || status.bCodeMessage.length === 0) {
    return status.developerMessage || "Unknown Nasdaq API Error";
  }
  return status.bCodeMessage.map((err) => `code: ${err.code} = ${err.errorMessage}`).join("::");
}
function log(level, msg, data) {
  const payload = data instanceof Error ? { error: serializeError(data) } : data;
  nasdaqUnlimitedLogger[level](msg, payload);
}
function getNasdaqHeaders(url) {
  const chromeVersion = ConfigManager.get("markets.chromeVersion") ?? "145";
  const isCharting = url.includes("charting");
  const headers = isCharting ? {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    priority: "u=1, i",
    "sec-ch-ua": `"Google Chrome";v="${chromeVersion}", "Not-A.Brand";v="8", "Chromium";v="${chromeVersion}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    referer: "https://charting.nasdaq.com/dynamic/chart.html",
    "user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`
  } : {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.nasdaq.com",
    referer: "https://www.nasdaq.com/",
    "sec-ch-ua": `"Google Chrome";v="${chromeVersion}", "Not-A.Brand";v="8", "Chromium";v="${chromeVersion}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`
  };
  const configHeaders = ConfigManager.get("markets.nasdaq.headers");
  return configHeaders ? { ...headers, ...configHeaders } : headers;
}
async function nasdaqEndPoint(url, options = {}) {
  const urlStr = typeof url === "string" ? url : url.toString();
  const headers = { ...getNasdaqHeaders(urlStr), ...options.headers ?? {} };
  const result = await endPoint(url, { ...options, headers });
  if (result.status === "error") {
    log("error", "Transport Error", { url: urlStr, reason: result.reason });
    return {
      status: "error",
      reason: { message: "Transport Error", original: result.reason }
    };
  }
  const val = result.value;
  const nasdaqBody = val.body;
  if (nasdaqBody && typeof nasdaqBody === "object" && "status" in nasdaqBody) {
    const statusObj = nasdaqBody.status;
    if (statusObj?.rCode !== 200) {
      log("warn", "Request failed logic check", {
        url: urlStr,
        status: nasdaqBody.status
      });
      const errorMessage = statusObj ? apiErrorToString(statusObj) : "Malformed Nasdaq Response";
      return {
        status: "error",
        reason: { message: errorMessage }
      };
    }
  }
  const { body, ...details } = val;
  return {
    status: "success",
    value: body?.data,
    details
  };
}
async function nasdaqEndPoints(urls, options = {}) {
  const promises = urls.map((url) => nasdaqEndPoint(url, options));
  return Promise.all(promises);
}
var ApiNasdaqUnlimited = {
  /**
   * Executes a single Nasdaq API request.
   */
  endPoint: nasdaqEndPoint,
  /**
   * Executes multiple Nasdaq API requests in parallel.
   */
  endPoints: nasdaqEndPoints
};

// src/nasdaq/MarketSymbols.ts
import {
  logger as baseLogger,
  ConfigManager as ConfigManager2,
  createDatabase,
  detectRuntime as detectRuntime2,
  endPoint as endPoint2,
  endPoints,
  getTempDir,
  sleep
} from "@ckir/corelib";
import { DateTime } from "luxon";
import { serializeError as serializeError2 } from "serialize-error";

// src/nasdaq/AssetClass.ts
var Realtime = /* @__PURE__ */ ((Realtime2) => {
  Realtime2["Stocks"] = "stocks";
  Realtime2["Etf"] = "etf";
  Realtime2["Currencies"] = "currencies";
  Realtime2["Crypto"] = "crypto";
  return Realtime2;
})(Realtime || {});

// src/nasdaq/MarketSymbols.ts
var marketSymbolsLogger = baseLogger.child({ section: "MarketSymbols" });
var DEFAULT_NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt";
var DEFAULT_OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt";
var DEFAULT_INITIAL_BACKOFF_MS = 1e3;
var DEFAULT_MAX_RETRY_BACKOFF_MS = 36e5;
var DEFAULT_MAX_FETCH_RETRIES = 10;
var MarketSymbols = class {
  /**
   * @param db - Optional database configuration or existing instance:
   * - `undefined` → uses `${getTempDir()}/NasdaqSymbols.sqlite`
   * - `string` → local SQLite file path
   * - `{ dbUrl: string; dbToken: string }` → Turso/LibSQL remote
   * - `Database` → An existing instance of a Database driver
   * @param ingestors - Array of ingestor URLs (e.g., Google App Script endpoints) to query for missing symbols.
   */
  constructor(db, ingestors = []) {
    this.ingestors = ingestors;
    if (db && typeof db.query === "function") {
      this.db = db;
      this.isDbOwner = false;
      return;
    }
    this.isDbOwner = true;
    if (!db) {
      const path = `${getTempDir()}/NasdaqSymbols.sqlite`;
      this.config = {
        dialect: "sqlite",
        url: `file:${path}`,
        mode: "stateful"
      };
    } else if (typeof db === "string") {
      this.config = {
        dialect: "sqlite",
        url: db.startsWith("libsql://") || db.startsWith("file:") ? db : `file:${db}`,
        mode: "stateful"
      };
    } else {
      const turso = db;
      this.config = {
        dialect: "sqlite",
        url: turso.dbUrl,
        authToken: turso.dbToken,
        mode: "stateful"
      };
    }
  }
  ingestors;
  db = null;
  initialized = false;
  isDbOwner = true;
  config;
  /**
   * Registry mapping URL patterns to specific ingestor methods.
   * Designed to be "open" for additional ingestors in future releases.
   */
  ingestorRegistry = [
    {
      pattern: /script\.google\.com/i,
      processor: this.ingestorGAS.bind(this)
    }
  ];
  /**
   * Force a full refresh of the symbol database.
   * Called automatically on first use if needed.
   */
  async refresh() {
    await this.ensureInitialized();
    await this.performRefresh();
  }
  /**
   * Get symbol data.
   * Searches Nasdaq API, external ingestors, and the DB. The sequence order is
   * optimized dynamically based on whether it is running in an Edge environment.
   * @returns `null` if the symbol is not found or is inactive.
   */
  async get(symbol) {
    const runtime2 = detectRuntime2();
    const isEdge = ["cloudflare", "aws-lambda", "gcp-cloudrun"].includes(
      runtime2
    );
    if (isEdge) {
      let res2 = await this.searchNasdaqApi(symbol);
      if (res2) return res2;
      res2 = await this.searchIngestors(symbol);
      if (res2) return res2;
      return await this.searchDb(symbol);
    }
    let res = await this.searchDb(symbol);
    if (res) return res;
    res = await this.searchNasdaqApi(symbol);
    if (res) return res;
    return await this.searchIngestors(symbol);
  }
  /**
   * Graceful shutdown – disconnects the database driver if it was created internally.
   */
  async close() {
    if (this.db) {
      if (this.isDbOwner) {
        await this.db.disconnect();
      }
      this.db = null;
      this.initialized = false;
    }
  }
  // -----------------------------------------------------------------------
  // Search Sequences
  // -----------------------------------------------------------------------
  /**
   * Queries the official Nasdaq autocomplete API for a symbol.
   * Filters for an exact match.
   */
  async searchNasdaqApi(symbol) {
    try {
      const url = `https://api.nasdaq.com/api/autocomplete/slookup/10?search=${encodeURIComponent(symbol)}`;
      const result = await ApiNasdaqUnlimited.endPoint(url);
      if (result.status === "success" && Array.isArray(result.value)) {
        const match = result.value.find(
          (item) => String(item.symbol).toUpperCase() === symbol.toUpperCase()
        );
        if (match) {
          const assetLower = match.asset ? String(match.asset).toLowerCase() : "";
          let type = "eod";
          if (Object.values(Realtime).includes(assetLower)) {
            type = "rt";
          }
          return {
            symbol: String(match.symbol),
            name: String(match.name ?? "").trim(),
            type,
            class: assetLower,
            ts: Date.now(),
            active: true
          };
        }
      }
    } catch (e) {
      marketSymbolsLogger.warn("SearchNasdaqApi failed", {
        symbol,
        error: serializeError2(e)
      });
    }
    return null;
  }
  /**
   * Queries external ingestors defined in the constructor based on the internal registry pattern.
   */
  async searchIngestors(symbol) {
    if (!this.ingestors || this.ingestors.length === 0) return null;
    for (const url of this.ingestors) {
      for (const entry of this.ingestorRegistry) {
        if (entry.pattern.test(url)) {
          try {
            const result = await entry.processor(url, symbol);
            if (result) return result;
          } catch (e) {
            marketSymbolsLogger.warn("Ingestor failed", {
              url,
              error: serializeError2(e)
            });
          }
        }
      }
    }
    return null;
  }
  /**
   * Specifically processes Google Apps Script (GAS) ingestor URLs.
   */
  async ingestorGAS(baseUrl, symbol) {
    const url = new URL(baseUrl);
    url.searchParams.set("symbol", symbol);
    const result = await endPoint2(url.toString());
    if (result.status === "success" && result.value?.body) {
      const body = result.value.body;
      if (body.status === "success" && body.value) {
        const data = body.value;
        if (String(data.symbol).toUpperCase() === symbol.toUpperCase()) {
          return {
            symbol: String(data.symbol),
            name: String(data.name || ""),
            type: data.type || "eod",
            class: String(data.class || ""),
            ts: Number(data.ts) || Date.now(),
            active: typeof data.active === "boolean" ? data.active : true
          };
        }
      }
    }
    return null;
  }
  /**
   * Searches the local or remote SQLite database.
   */
  async searchDb(symbol) {
    try {
      const db = await this.ensureInitialized();
      const result = await db.query(
        "SELECT symbol, type, class, name, ts, active FROM nasdaq_symbols WHERE symbol = ? AND active = true LIMIT 1",
        [symbol.toUpperCase()]
      );
      if (result.status === "success" && result.value.rows.length > 0) {
        return result.value.rows[0];
      }
    } catch (e) {
      marketSymbolsLogger.warn("SearchDb query failed", {
        symbol,
        error: serializeError2(e)
      });
    }
    return null;
  }
  // -----------------------------------------------------------------------
  // Private Database Management
  // -----------------------------------------------------------------------
  /**
   * Initializes the database driver if not already done.
   * Creates the `nasdaq_symbols` table if it doesn't exist.
   * Creates an index on the `active` column if it doesn't exist.
   * Called automatically on first use, and before any other operations.
   */
  async ensureInitialized() {
    if (this.db && this.initialized) return this.db;
    if (!this.db) {
      if (!this.config) {
        throw new Error(
          "MarketSymbols: Database instance not provided and no configuration available."
        );
      }
      this.db = await createDatabase(this.config);
    }
    await this.db.query(`
			CREATE TABLE IF NOT EXISTS nasdaq_symbols (
				symbol   TEXT PRIMARY KEY,
				type     TEXT NOT NULL,
				class    TEXT NOT NULL,
				name     TEXT NOT NULL,
				ts       INTEGER NOT NULL,
				active   BOOLEAN NOT NULL DEFAULT true
			)
		`);
    await this.db.query(
      "CREATE INDEX IF NOT EXISTS idx_nasdaq_symbols_active ON nasdaq_symbols(active)"
    );
    this.initialized = true;
    await this.performRefresh();
    return this.db;
  }
  /**
   * Checks if the database needs to be refreshed.
   * Returns true if the database has never been populated, or if the last refresh was not today.
   * @returns {Promise<boolean>} true if the database needs to be refreshed
   */
  async needsRefresh() {
    if (!this.db) return true;
    const result = await this.db.query(
      "SELECT MAX(ts) AS max_ts FROM nasdaq_symbols LIMIT 1"
    );
    if (result.status === "error") return true;
    const maxTs = result.value.rows[0]?.max_ts;
    if (!maxTs) return true;
    const lastDate = DateTime.fromMillis(maxTs).setZone("America/New_York").startOf("day");
    const today = DateTime.now().setZone("America/New_York").startOf("day");
    return !lastDate.equals(today);
  }
  /**
   * Refreshes the symbol database.
   * Only runs if the database has never been populated, or if the last refresh was not today.
   * Downloads the official Nasdaq symbol directories, parses them, and updates the database.
   * @returns {Promise<void>} resolves after the database has been refreshed
   */
  async performRefresh() {
    if (!await this.needsRefresh()) return;
    if (!this.db) return;
    marketSymbolsLogger.info("Starting full symbol directory refresh");
    let texts;
    try {
      texts = await this.fetchSymbolFilesWithRetry();
    } catch (err) {
      if (await this.hasExistingData()) {
        marketSymbolsLogger.warn(
          "Symbol refresh abandoned, using existing data",
          {
            error: serializeError2(err)
          }
        );
        return;
      }
      throw err;
    }
    const nasdaqRows = this.parseNasdaqListed(texts.nasdaqText);
    const otherRows = this.parseOtherListed(texts.otherText);
    const allRows = /* @__PURE__ */ new Map();
    for (const r of nasdaqRows) allRows.set(r.symbol, r);
    for (const r of otherRows) {
      if (!allRows.has(r.symbol)) allRows.set(r.symbol, r);
    }
    const now = Date.now();
    const rowsArray = Array.from(allRows.values()).map((r) => ({
      ...r,
      ts: now
    }));
    await this.db.transaction(async () => {
      if (!this.db) throw new Error("Database lost during transaction");
      await this.db.query("UPDATE nasdaq_symbols SET active = false");
      const BATCH_SIZE = 150;
      for (let i = 0; i < rowsArray.length; i += BATCH_SIZE) {
        const batch = rowsArray.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, true)").join(", ");
        const params = batch.flatMap((r) => [
          r.symbol,
          r.type,
          r.class,
          r.name,
          r.ts
        ]);
        await this.db.query(
          `INSERT INTO nasdaq_symbols (symbol, type, class, name, ts, active)
					 VALUES ${placeholders}
					 ON CONFLICT(symbol) DO UPDATE SET
						type   = excluded.type,
						class  = excluded.class,
						name   = excluded.name,
						ts     = excluded.ts,
						active = true`,
          params
        );
      }
      return {
        status: "success",
        value: null
      };
    });
  }
  /**
   * Downloads the official Nasdaq symbol directories with retry and circuit breaker.
   * Retries with exponential backoff up to `markets.nasdaq.symbols.maxRetryBackoffMs` per interval.
   * Stops after `markets.nasdaq.symbols.maxFetchRetries` consecutive failures even when existing data is present.
   * Throws immediately on first failure when no existing data exists.
   */
  async fetchSymbolFilesWithRetry() {
    const nasdaqListedUrl = ConfigManager2.get("markets.nasdaq.symbols.nasdaqListedUrl") ?? DEFAULT_NASDAQ_LISTED_URL;
    const otherListedUrl = ConfigManager2.get("markets.nasdaq.symbols.otherListedUrl") ?? DEFAULT_OTHER_LISTED_URL;
    const maxRetryBackoffMs = ConfigManager2.get("markets.nasdaq.symbols.maxRetryBackoffMs") ?? DEFAULT_MAX_RETRY_BACKOFF_MS;
    const maxFetchRetries = ConfigManager2.get("markets.nasdaq.symbols.maxFetchRetries") ?? DEFAULT_MAX_FETCH_RETRIES;
    let backoffMs = ConfigManager2.get("markets.nasdaq.symbols.initialBackoffMs") ?? DEFAULT_INITIAL_BACKOFF_MS;
    let retryCount = 0;
    while (retryCount <= maxFetchRetries) {
      try {
        const results = await endPoints(
          [nasdaqListedUrl, otherListedUrl],
          {
            headers: {
              accept: "text/plain, */*",
              "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
            }
          }
        );
        if (results[0].status === "success" && results[1].status === "success") {
          return {
            nasdaqText: results[0].value.body,
            otherText: results[1].value.body
          };
        }
        const errorResult = results[0].status === "error" ? results[0] : results[1];
        const reason = errorResult.status === "error" ? errorResult.reason : {};
        marketSymbolsLogger.warn("Symbol directory fetch failed \u2013 retrying", {
          retryCount,
          reason: serializeError2(reason)
        });
        const hasExistingData = await this.hasExistingData();
        if (!hasExistingData) {
          throw new Error(
            `Failed to construct symbols db - ${reason.message ?? JSON.stringify(serializeError2(reason))}`
          );
        }
        if (retryCount >= maxFetchRetries) {
          throw new Error(
            `Symbol fetch circuit breaker: gave up after ${maxFetchRetries} retries`
          );
        }
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, maxRetryBackoffMs);
        retryCount++;
      } catch (err) {
        const hasExistingData = await this.hasExistingData();
        if (hasExistingData && retryCount < maxFetchRetries) {
          marketSymbolsLogger.warn("Symbol directory fetch thrown \u2013 retrying", {
            retryCount,
            error: serializeError2(err)
          });
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, maxRetryBackoffMs);
          retryCount++;
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      `Symbol fetch circuit breaker: gave up after ${maxFetchRetries} retries`
    );
  }
  /**
   * Checks if there is existing data in the database.
   * Returns true if there is any existing data, false otherwise.
   * @returns {Promise<boolean>} true if there is any existing data, false otherwise
   */
  async hasExistingData() {
    if (!this.db) return false;
    const res = await this.db.query(
      "SELECT COUNT(*) AS count FROM nasdaq_symbols LIMIT 1"
    );
    if (res.status === "success") {
      return (res.value.rows[0]?.count ?? 0) > 0;
    }
    return false;
  }
  /**
   * Parses the official Nasdaq symbol directory file (nasdaqlisted.txt).
   * Skips the first two lines (header) and empty lines.
   * Skips lines with less than 8 fields (invalid).
   * Extracts the symbol, name, and ETF status from the line.
   * Creates a MarketSymbolRow with the extracted data and adds it to the result array.
   * @param {string} text - The content of the nasdaqlisted.txt file as a string
   * @returns {MarketSymbolRow[]} - An array of MarketSymbolRow objects parsed from the file
   */
  parseNasdaqListed(text) {
    const rows = [];
    const lines = text.trim().split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("Symbol|") || line.startsWith("File Creation Time|") || !line.trim())
        continue;
      const fields = line.split("|");
      if (fields.length < 8) continue;
      const symbol = fields[0].trim();
      const name = fields[1].trim();
      const isEtf = fields[6] === "Y";
      rows.push({
        symbol,
        name,
        type: "rt",
        class: isEtf ? "etf" /* Etf */ : "stocks" /* Stocks */,
        ts: 0,
        active: true
      });
    }
    return rows;
  }
  /**
   * Parses the official Nasdaq symbol directory file (otherlisted.txt).
   * Skips the first two lines (header) and empty lines.
   * Skips lines with less than 5 fields (invalid).
   * Extracts the symbol, name, and ETF status from the line.
   * Creates a MarketSymbolRow with the extracted data and adds it to the result array.
   * @param {string} text - The content of the otherlisted.txt file as a string
   * @returns {MarketSymbolRow[]} - An array of MarketSymbolRow objects parsed from the file
   */
  parseOtherListed(text) {
    const rows = [];
    const lines = text.trim().split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("Symbol|") || line.startsWith("File Creation Time|") || !line.trim())
        continue;
      const fields = line.split("|");
      if (fields.length < 5) continue;
      const symbol = fields[0].trim();
      const name = fields[1].trim();
      const isEtf = fields[4] === "Y";
      rows.push({
        symbol,
        name,
        type: "rt",
        class: isEtf ? "etf" /* Etf */ : "stocks" /* Stocks */,
        ts: 0,
        active: true
      });
    }
    return rows;
  }
};

// src/nasdaq/ApiNasdaqQuotes.ts
var DEFAULT_CONCURRENCY_LIMIT = 5;
var ApiNasdaqQuotes = class {
  logger;
  marketSymbols;
  requestProxied;
  isInternalMarketSymbols;
  concurrencyLimit;
  /**
   * Creates an instance of ApiNasdaqQuotes.
   * @param options Configuration options for the module.
   */
  constructor(options = {}) {
    const baseLogger2 = options.logger || globalThis.logger;
    this.logger = baseLogger2?.child({ section: "ApiNasdaqQuotes" });
    this.concurrencyLimit = options.concurrencyLimit ?? ConfigManager3.get("markets.nasdaq.quotes.concurrencyLimit") ?? DEFAULT_CONCURRENCY_LIMIT;
    if (options.marketSymbols) {
      this.marketSymbols = options.marketSymbols;
      this.isInternalMarketSymbols = false;
    } else {
      this.marketSymbols = new MarketSymbols();
      this.isInternalMarketSymbols = true;
    }
    if (options.proxies && options.proxies.length > 0) {
      this.requestProxied = new RequestProxied(options.proxies);
    }
  }
  /**
   * Retrieves real-time quotes for a batch of symbols.
   * Results are returned in an array mirroring the order of the input symbols.
   * @param symbols An array of ticker symbols (e.g. ['AAPL', 'MSFT']).
   * @returns A promise resolving to an array of NasdaqResult objects.
   */
  async getNasdaqQuote(symbols) {
    const results = new Array(symbols.length);
    const fetchQueue = [];
    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i].toUpperCase();
      try {
        const symbolData = await this.marketSymbols.get(symbol);
        if (!symbolData) {
          results[i] = {
            status: "error",
            reason: { message: `Symbol ${symbol} not found in MarketSymbols` }
          };
          continue;
        }
        const assetClass = symbolData.class || "stocks";
        const url = `https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=${assetClass.toLowerCase()}`;
        fetchQueue.push({ symbol, url, index: i });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn("Error resolving asset class", {
          symbol,
          error: message
        });
        results[i] = {
          status: "error",
          reason: {
            message: `Internal error during symbol resolution: ${message}`
          }
        };
      }
    }
    if (fetchQueue.length === 0) return results;
    if (this.requestProxied) {
      const urls = fetchQueue.map((q) => q.url);
      const proxyResults = await this.requestProxied.endPoints(urls);
      for (let i = 0; i < proxyResults.length; i++) {
        const q = fetchQueue[i];
        const pRes = proxyResults[i];
        if (pRes.status === "success") {
          const body = pRes.value.body;
          const statusObj = body?.status;
          if (statusObj?.rCode === 200) {
            results[q.index] = {
              status: "success",
              value: body.data,
              details: pRes.value
            };
          } else {
            const devMsg = typeof statusObj?.developerMessage === "string" ? statusObj.developerMessage : "Nasdaq API Error via Proxy";
            results[q.index] = {
              status: "error",
              reason: { message: devMsg }
            };
          }
        } else {
          const errMsg = pRes.reason?.message;
          results[q.index] = {
            status: "error",
            reason: {
              message: typeof errMsg === "string" ? errMsg : "Proxy request failed"
            }
          };
        }
      }
    } else {
      for (let i = 0; i < fetchQueue.length; i += this.concurrencyLimit) {
        const batch = fetchQueue.slice(i, i + this.concurrencyLimit);
        const batchTasks = batch.map(async (q) => {
          try {
            const res = await ApiNasdaqUnlimited.endPoint(q.url);
            results[q.index] = res;
          } catch (error) {
            results[q.index] = {
              status: "error",
              reason: {
                message: error instanceof Error ? error.message : "Unlimited fetch failed"
              }
            };
          }
        });
        await Promise.all(batchTasks);
      }
    }
    return results;
  }
  /**
   * Properly shuts down internal resources and database connections.
   * Must be called if MarketSymbols was instantiated internally.
   */
  async close() {
    if (this.isInternalMarketSymbols) {
      await this.marketSymbols.close();
    }
  }
};

// src/nasdaq/CnnFearAndGreed.ts
import {
  ConfigManager as ConfigManager4,
  endPoint as endPoint3,
  logger as logger2
} from "@ckir/corelib";
import { DateTime as DateTime2 } from "luxon";
import { serializeError as serializeError3 } from "serialize-error";
var cnnLogger = logger2.child({ section: "CnnFearAndGreed" });
var CnnFearAndGreedFilter = /* @__PURE__ */ ((CnnFearAndGreedFilter2) => {
  CnnFearAndGreedFilter2["FearAndGreed"] = "fear_and_greed";
  CnnFearAndGreedFilter2["FearAndGreedHistorical"] = "fear_and_greed_historical";
  CnnFearAndGreedFilter2["MarketMomentumSp500"] = "market_momentum_sp500";
  CnnFearAndGreedFilter2["MarketMomentumSp125"] = "market_momentum_sp125";
  CnnFearAndGreedFilter2["StockPriceStrength"] = "stock_price_strength";
  CnnFearAndGreedFilter2["StockPriceBreadth"] = "stock_price_breadth";
  CnnFearAndGreedFilter2["PutCallOptions"] = "put_call_options";
  CnnFearAndGreedFilter2["MarketVolatilityVix"] = "market_volatility_vix";
  CnnFearAndGreedFilter2["MarketVolatilityVix50"] = "market_volatility_vix_50";
  CnnFearAndGreedFilter2["JunkBondDemand"] = "junk_bond_demand";
  CnnFearAndGreedFilter2["SafeHavenDemand"] = "safe_haven_demand";
  return CnnFearAndGreedFilter2;
})(CnnFearAndGreedFilter || {});
var ALL_KEYS = Object.values(
  CnnFearAndGreedFilter
);
function getDefaultHeaders() {
  const chromeVersion = ConfigManager4.get("markets.chromeVersion") ?? "146";
  return {
    accept: "*/*",
    "accept-language": "en,el;q=0.9",
    origin: "https://edition.cnn.com",
    priority: "u=1, i",
    referer: "https://edition.cnn.com/",
    "sec-ch-ua": `"Chromium";v="${chromeVersion}", "Not-A.Brand";v="24", "Google Chrome";v="${chromeVersion}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "user-agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`
  };
}
function getHeaders() {
  const configHeaders = ConfigManager4.get("markets.cnn.headers");
  return { ...getDefaultHeaders(), ...configHeaders ?? {} };
}
function log2(level, msg, data) {
  const payload = data instanceof Error ? { error: serializeError3(data) } : data;
  cnnLogger[level](msg, payload);
}
function buildUrl(date) {
  const url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
  if (date === "Historical") return url;
  const finalDate = date ?? DateTime2.now().toISODate();
  return `${url}/${finalDate}`;
}
function getFilteredValue(body, filter) {
  if (filter === "full") return body;
  const keys = Array.isArray(filter) ? filter : [filter];
  if (keys.length === 1 && !Array.isArray(filter)) {
    return body[keys[0]];
  }
  const result = {};
  keys.forEach((k) => {
    if (k in body) result[k] = body[k];
  });
  return result;
}
function validateKeys(body, filter) {
  const keysToCheck = filter === "full" ? ALL_KEYS : Array.isArray(filter) ? filter : [filter];
  for (const key of keysToCheck) {
    if (!(key in body) || body[key] == null) {
      return `Missing or null key: ${key}`;
    }
  }
  return null;
}
async function getFearAndGreed(date, filter = "fear_and_greed" /* FearAndGreed */, options = {}) {
  const url = buildUrl(date);
  const headers = { ...getHeaders(), ...options.headers ?? {} };
  const result = await endPoint3(url, { ...options, headers });
  if (result.status === "error") {
    log2("error", "Transport Error", { url, reason: result.reason });
    return {
      status: "error",
      reason: { message: "Transport Error", original: result.reason }
    };
  }
  const val = result.value;
  const body = val.body;
  if (!body || typeof body !== "object") {
    const msg = "Malformed CNN Response";
    log2("error", msg);
    return { status: "error", reason: { message: msg } };
  }
  const validationError = validateKeys(body, filter);
  if (validationError) {
    log2("warn", "Schema validation failed", { validationError, body });
    return {
      status: "error",
      reason: {
        message: `STRICT SCHEMA VALIDATION FAILED: ${validationError}`
      }
    };
  }
  const value = getFilteredValue(body, filter);
  log2("debug", "CNN FearAndGreed fetched successfully", { filter, url });
  return {
    status: "success",
    value,
    details: { ...val, body: void 0 }
  };
}
var CnnFearAndGreed = {
  /**
   * Fetches Fear & Greed Index data.
   */
  getFearAndGreed
};

// src/index.ts
import * as Luxon from "luxon";

// src/nasdaq/datafeeds/polling/historical/Historical.ts
import { endPoint as endPoint4 } from "@ckir/corelib";
import yahooFinance from "@gadicc/yahoo-finance2";

// src/nasdaq/datafeeds/polling/historical/providers/YahooHistoricalProvider.ts
import { logger as logger3 } from "@ckir/corelib";
import { DateTime as DateTime3 } from "luxon";
import { serializeError as serializeError4 } from "serialize-error";
var yahooHistoricalLogger = logger3.child({
  section: "YahooHistoricalProvider"
});
var YahooHistoricalProvider = class {
  constructor(yf2) {
    this.yf = yf2;
  }
  yf;
  async getHistoricalData(symbol, options) {
    try {
      const queryOptions = {
        period1: options.period1,
        period2: options.period2 || /* @__PURE__ */ new Date()
      };
      if (options.interval) queryOptions.interval = options.interval;
      const data = await this.yf.historical(symbol, queryOptions);
      const value = data.map((item) => ({
        symbol,
        date: DateTime3.fromJSDate(item.date).toUTC().toISO() || item.date.toISOString(),
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume: item.volume,
        adjClose: item.adjClose ?? null
      }));
      return { status: "success", value };
    } catch (error) {
      const serialized = serializeError4(error);
      yahooHistoricalLogger.error("Yahoo provider failed", {
        symbol,
        error: serialized
      });
      return {
        status: "error",
        reason: {
          message: serialized.message || "Failed to fetch historical data",
          payload: serialized
        }
      };
    }
  }
};

// src/nasdaq/datafeeds/polling/historical/Historical.ts
if (typeof globalThis.Deno === "undefined") {
  globalThis.Deno = {
    stdout: {
      isTerminal: () => false
    }
  };
}
async function corelibFetchAdapter(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const kyOptions = {
    method: init?.method ?? "GET",
    headers: init?.headers ?? {},
    body: init?.body,
    throwHttpErrors: false
  };
  const result = await endPoint4(url, kyOptions);
  if (result.status === "error" && !("status" in result.reason)) {
    throw new Error(
      result.reason.message || "Network Error in corelibFetchAdapter"
    );
  }
  const serialized = result.status === "success" ? result.value : result.reason;
  return {
    ok: serialized.ok,
    status: serialized.status,
    statusText: serialized.statusText,
    url: serialized.url,
    headers: new Headers(serialized.headers),
    text: async () => typeof serialized.body === "string" ? serialized.body : JSON.stringify(serialized.body),
    json: async () => typeof serialized.body === "string" ? JSON.parse(serialized.body) : serialized.body,
    blob: async () => new Blob([JSON.stringify(serialized.body)]),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(serialized.body)).buffer,
    clone: function() {
      return this;
    },
    body: null,
    bodyUsed: false,
    redirected: serialized.redirected,
    type: serialized.type || "basic"
  };
}
var yf = new yahooFinance({
  fetch: corelibFetchAdapter,
  suppressNotices: ["ripHistorical"],
  versionCheck: false
});
var defaultProvider = new YahooHistoricalProvider(yf);
var Historical = {
  /**
   * Retrieves historical data for a given symbol.
   */
  getData: (symbol, options) => defaultProvider.getHistoricalData(symbol, options)
};

// src/nasdaq/datafeeds/polling/nasdaq/NasdaqPolling.ts
import { EventEmitter } from "events";
import { logger as logger4 } from "@ckir/corelib";
import { serializeError as serializeError5 } from "serialize-error";
var nasdaqPollingLogger = logger4.child({ section: "NasdaqPolling" });
var NasdaqPolling = class extends EventEmitter {
  intervalId = null;
  subscriptions = /* @__PURE__ */ new Set();
  apiInterval;
  proxies;
  nasdaqQuotes;
  /**
   * @param apiInterval - Polling interval in milliseconds (defaults to 10000ms/10s).
   * @param proxies - Array of proxy URLs to rotate or use for requests.
   */
  constructor(apiInterval = 1e4, proxies = []) {
    super();
    this.apiInterval = apiInterval;
    this.proxies = proxies.map(
      (f) => f.endsWith("/") ? `${f}api/v1/markets/nasdaq` : `${f}/api/v1/markets/nasdaq`
    );
    this.nasdaqQuotes = new ApiNasdaqQuotes({
      proxies: this.proxies,
      logger: nasdaqPollingLogger
    });
  }
  /**
   * Updates the polling interval at runtime.
   * If polling is active, it will restart with the new interval.
   * @param value - New interval in milliseconds.
   */
  setApiInterval(value) {
    nasdaqPollingLogger.info(
      `Setting API interval from ${this.apiInterval}ms to ${value}ms`
    );
    this.apiInterval = value;
    if (this.intervalId !== null) {
      this.stop();
      this.start();
    }
  }
  /**
   * Adds symbols to the internal subscription list.
   * @param symbols - Array of stock symbols (e.g., ["AAPL", "MSFT"]).
   */
  subscribe(symbols) {
    for (const symbol of symbols) {
      this.subscriptions.add(symbol.toUpperCase());
    }
    nasdaqPollingLogger.info(
      `Subscribed to ${this.subscriptions.size} symbols`
    );
  }
  /**
   * Removes symbols from the internal subscription list.
   * @param symbols - Array of stock symbols to remove.
   */
  unsubscribe(symbols) {
    for (const symbol of symbols) {
      this.subscriptions.delete(symbol.toUpperCase());
    }
    nasdaqPollingLogger.info(
      `Unsubscribed from ${this.subscriptions.size} symbols`
    );
  }
  /**
   * Starts the polling process at the defined apiInterval.
   * If polling is already active, this method does nothing.
   */
  start() {
    if (this.intervalId !== null) {
      nasdaqPollingLogger.warn("Polling is already active.");
      return;
    }
    nasdaqPollingLogger.info(
      `Starting Nasdaq polling with interval ${this.apiInterval}ms and ${this.proxies.length} proxies.`
    );
    this.emit("status", "started");
    void this.poll();
    this.intervalId = setInterval(() => {
      void this.poll();
    }, this.apiInterval);
  }
  /**
   * Stops the polling process.
   * Existing subscriptions are preserved.
   */
  stop() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      nasdaqPollingLogger.info("Nasdaq polling stopped.");
      this.emit("status", "stopped");
    }
  }
  /**
   * Resets the internal subscription list and halts active polling.
   */
  clear() {
    this.subscriptions.clear();
    nasdaqPollingLogger.info("Subscriptions cleared.");
    this.stop();
  }
  /**
   * Internal logic to fetch data from ApiNasdaqQuotes and emit results.
   */
  async poll() {
    if (this.subscriptions.size === 0) {
      return;
    }
    const symbolList = Array.from(this.subscriptions);
    try {
      const results = await this.nasdaqQuotes.getNasdaqQuote(symbolList);
      const validResults = [];
      for (const result of results) {
        if (result.status === "success" && result.value !== void 0) {
          this.emit("data", result.value);
          validResults.push(result.value);
        } else if (result.status === "error") {
          nasdaqPollingLogger.error("Error fetching quote", {
            error: result.reason
          });
          this.emit("error", result.reason);
        }
      }
      if (validResults.length > 0) {
        this.emit("poll-complete", validResults);
      }
    } catch (error) {
      const serialized = serializeError5(error);
      nasdaqPollingLogger.error("Polling execution failed", {
        error: serialized
      });
      this.emit("error", serialized);
    }
  }
};

// src/nasdaq/datafeeds/streaming/alpaca/AlpacaStreaming.ts
import { EventEmitter as EventEmitter2 } from "events";
import { coreFFI, getMode, getTempDir as getTempDir2 } from "@ckir/corelib";
var RustAlpaca = coreFFI?.AlpacaStreaming;
var AlpacaStreaming = class extends EventEmitter2 {
  rust;
  initialized = false;
  constructor() {
    super();
    if (!RustAlpaca) {
      throw new Error(
        "AlpacaStreaming (Native) is not supported in this runtime (no FFI available)."
      );
    }
    this.rust = new RustAlpaca(
      (_err, record) => this.emit("log", record),
      (_err, data) => this.emit("pricing", data),
      (_err, event) => {
        if (event) {
          this.emit(event.type, event.data ?? null);
        }
      }
    );
    if (getMode() === "development") {
      this.rust.clean();
    }
  }
  /**
   * Initializes the configuration for the Alpaca streaming client.
   *
   * @param {object} [config] - Configuration options.
   * @param {string} [config.dbPath] - Path to the local persistence database. Defaults to system temp.
   * @param {number} [config.silenceSeconds] - Duration of silence (in seconds) before triggering a reconnect.
   * @param {string} [config.baseUrl] - Alpaca API base URL.
   * @param {string} [config.keyId] - Alpaca API Key ID.
   * @param {string} [config.secretKey] - Alpaca API Secret Key.
   * @returns {Promise<void>}
   */
  async init(config = {}) {
    const finalConfig = {
      dbPath: config.dbPath ?? `${getTempDir2()}/alpaca_streaming.redb`,
      silenceSeconds: config.silenceSeconds ?? 60,
      baseUrl: config.baseUrl ?? void 0,
      keyId: config.keyId ?? void 0,
      secretKey: config.secretKey ?? void 0
    };
    await this.rust.init(finalConfig);
    this.initialized = true;
  }
  /**
   * Starts the streaming client and begins connecting to Alpaca.
   * @returns {Promise<void>}
   */
  async start() {
    if (!this.initialized) await this.init();
    await this.rust.start();
  }
  /**
   * Subscribes to real-time updates for the specified symbols.
   * @param {string[]} symbols - Array of trading symbols.
   */
  subscribe(symbols) {
    this.rust.subscribe(symbols);
  }
  /**
   * Unsubscribes from updates for the specified symbols.
   * @param {string[]} symbols - Array of trading symbols.
   */
  unsubscribe(symbols) {
    this.rust.unsubscribe(symbols);
  }
  /**
   * Cleans up the local state/database.
   */
  clean() {
    this.rust.clean();
  }
  /**
   * Stops the streaming client and disconnects.
   */
  stop() {
    this.rust.stop();
  }
};

// src/nasdaq/datafeeds/streaming/yahoo/YahooStreaming.ts
import { EventEmitter as EventEmitter3 } from "events";
import { coreFFI as coreFFI2, getMode as getMode2, getTempDir as getTempDir3 } from "@ckir/corelib";
var RustYahoo = coreFFI2?.YahooStreaming;
var YahooStreaming = class extends EventEmitter3 {
  rust;
  initialized = false;
  constructor() {
    super();
    if (!RustYahoo) {
      throw new Error(
        "YahooStreaming (Native) is not supported in this runtime (no FFI available)."
      );
    }
    this.rust = new RustYahoo(
      (_err, record) => this.emit("log", record),
      (_err, data) => this.emit("pricing", data),
      (_err, event) => {
        if (event) {
          this.emit(event.type, event.data ?? null);
        }
      }
    );
    if (getMode2() === "development") {
      this.rust.clean();
    }
  }
  /**
   * Initializes the configuration for the Yahoo streaming client.
   *
   * @param {object} [config] - Configuration options.
   * @param {string} [config.dbPath] - Path to the local persistence database.
   * @param {number} [config.silenceSeconds] - Duration of silence (in seconds) before triggering a reconnect.
   * @returns {Promise<void>}
   */
  async init(config = {}) {
    const finalConfig = {
      dbPath: config.dbPath ?? `${getTempDir3()}/yahoo_streaming.redb`,
      silenceSeconds: config.silenceSeconds ?? 60
    };
    await this.rust.init(finalConfig);
    this.initialized = true;
  }
  /**
   * Starts the streaming client and begins connecting.
   * @returns {Promise<void>}
   */
  async start() {
    if (!this.initialized) await this.init();
    await this.rust.start();
  }
  /**
   * Subscribes to real-time updates for the specified symbols.
   * @param {string[]} symbols - Array of trading symbols.
   */
  subscribe(symbols) {
    this.rust.subscribe(symbols);
  }
  /**
   * Unsubscribes from updates for the specified symbols.
   * @param {string[]} symbols - Array of trading symbols.
   */
  unsubscribe(symbols) {
    this.rust.unsubscribe(symbols);
  }
  /**
   * Cleans up the local state/database.
   */
  clean() {
    this.rust.clean();
  }
  /**
   * Stops the streaming client and disconnects.
   */
  stop() {
    this.rust.stop();
  }
};

// src/nasdaq/groups/Top100.ts
import { logger as logger5 } from "@ckir/corelib";
var top100Logger = logger5.child({ section: "Top100" });
var cachedSymbols = null;
var activeFetchPromise = null;
async function getSymbolsTop100() {
  if (cachedSymbols !== null) {
    return cachedSymbols;
  }
  if (activeFetchPromise !== null) {
    return activeFetchPromise;
  }
  activeFetchPromise = (async () => {
    try {
      const url = "https://api.nasdaq.com/api/quote/list-type/nasdaq100";
      const response = await ApiNasdaqUnlimited.endPoint(url);
      if (response.status === "error") {
        top100Logger.warn("Failed to fetch Nasdaq 100 symbols via API", {
          reason: response.reason
        });
        return [];
      }
      const rows = response.value?.data?.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        top100Logger.warn(
          "Nasdaq 100 API returned an empty or invalid dataset",
          {
            payload: response.value
          }
        );
        return [];
      }
      const symbols = rows.map((row) => row.symbol).sort((a, b) => a.localeCompare(b));
      cachedSymbols = symbols;
      return symbols;
    } catch (error) {
      top100Logger.warn("Unexpected error in Top100 module", {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    } finally {
      activeFetchPromise = null;
    }
  })();
  return activeFetchPromise;
}

// src/nasdaq/MarketMonitor.ts
import { EventEmitter as EventEmitter4 } from "events";
import { ConfigManager as ConfigManager6, logger as logger7 } from "@ckir/corelib";
import { DateTime as DateTime5 } from "luxon";
import { serializeError as serializeError9 } from "serialize-error";

// ../node_modules/.pnpm/deepmerge-ts@7.1.5/node_modules/deepmerge-ts/dist/index.mjs
var actions = {
  defaultMerge: /* @__PURE__ */ Symbol("deepmerge-ts: default merge"),
  skip: /* @__PURE__ */ Symbol("deepmerge-ts: skip")
};
var actionsInto = {
  defaultMerge: actions.defaultMerge
};
function defaultMetaDataUpdater(previousMeta, metaMeta) {
  return metaMeta;
}
function defaultFilterValues(values, meta) {
  return values.filter((value) => value !== void 0);
}
var ObjectType;
(function(ObjectType2) {
  ObjectType2[ObjectType2["NOT"] = 0] = "NOT";
  ObjectType2[ObjectType2["RECORD"] = 1] = "RECORD";
  ObjectType2[ObjectType2["ARRAY"] = 2] = "ARRAY";
  ObjectType2[ObjectType2["SET"] = 3] = "SET";
  ObjectType2[ObjectType2["MAP"] = 4] = "MAP";
  ObjectType2[ObjectType2["OTHER"] = 5] = "OTHER";
})(ObjectType || (ObjectType = {}));
function getObjectType(object) {
  if (typeof object !== "object" || object === null) {
    return 0;
  }
  if (Array.isArray(object)) {
    return 2;
  }
  if (isRecord(object)) {
    return 1;
  }
  if (object instanceof Set) {
    return 3;
  }
  if (object instanceof Map) {
    return 4;
  }
  return 5;
}
function getKeys(objects) {
  const keys = /* @__PURE__ */ new Set();
  for (const object of objects) {
    for (const key of [...Object.keys(object), ...Object.getOwnPropertySymbols(object)]) {
      keys.add(key);
    }
  }
  return keys;
}
function objectHasProperty(object, property) {
  return typeof object === "object" && Object.prototype.propertyIsEnumerable.call(object, property);
}
function getIterableOfIterables(iterables) {
  let mut_iterablesIndex = 0;
  let mut_iterator = iterables[0]?.[Symbol.iterator]();
  return {
    [Symbol.iterator]() {
      return {
        next() {
          do {
            if (mut_iterator === void 0) {
              return { done: true, value: void 0 };
            }
            const result = mut_iterator.next();
            if (result.done === true) {
              mut_iterablesIndex += 1;
              mut_iterator = iterables[mut_iterablesIndex]?.[Symbol.iterator]();
              continue;
            }
            return {
              done: false,
              value: result.value
            };
          } while (true);
        }
      };
    }
  };
}
var validRecordToStringValues = ["[object Object]", "[object Module]"];
function isRecord(value) {
  if (!validRecordToStringValues.includes(Object.prototype.toString.call(value))) {
    return false;
  }
  const { constructor } = value;
  if (constructor === void 0) {
    return true;
  }
  const prototype = constructor.prototype;
  if (prototype === null || typeof prototype !== "object" || !validRecordToStringValues.includes(Object.prototype.toString.call(prototype))) {
    return false;
  }
  if (!prototype.hasOwnProperty("isPrototypeOf")) {
    return false;
  }
  return true;
}
function mergeRecords$1(values, utils, meta) {
  const result = {};
  for (const key of getKeys(values)) {
    const propValues = [];
    for (const value of values) {
      if (objectHasProperty(value, key)) {
        propValues.push(value[key]);
      }
    }
    if (propValues.length === 0) {
      continue;
    }
    const updatedMeta = utils.metaDataUpdater(meta, {
      key,
      parents: values
    });
    const propertyResult = mergeUnknowns(propValues, utils, updatedMeta);
    if (propertyResult === actions.skip) {
      continue;
    }
    if (key === "__proto__") {
      Object.defineProperty(result, key, {
        value: propertyResult,
        configurable: true,
        enumerable: true,
        writable: true
      });
    } else {
      result[key] = propertyResult;
    }
  }
  return result;
}
function mergeArrays$1(values) {
  return values.flat();
}
function mergeSets$1(values) {
  return new Set(getIterableOfIterables(values));
}
function mergeMaps$1(values) {
  return new Map(getIterableOfIterables(values));
}
function mergeOthers$1(values) {
  return values.at(-1);
}
var mergeFunctions = {
  mergeRecords: mergeRecords$1,
  mergeArrays: mergeArrays$1,
  mergeSets: mergeSets$1,
  mergeMaps: mergeMaps$1,
  mergeOthers: mergeOthers$1
};
function deepmergeCustom(options, rootMetaData) {
  const utils = getUtils(options, customizedDeepmerge);
  function customizedDeepmerge(...objects) {
    return mergeUnknowns(objects, utils, rootMetaData);
  }
  return customizedDeepmerge;
}
function getUtils(options, customizedDeepmerge) {
  return {
    defaultMergeFunctions: mergeFunctions,
    mergeFunctions: {
      ...mergeFunctions,
      ...Object.fromEntries(Object.entries(options).filter(([key, option]) => Object.hasOwn(mergeFunctions, key)).map(([key, option]) => option === false ? [key, mergeFunctions.mergeOthers] : [key, option]))
    },
    metaDataUpdater: options.metaDataUpdater ?? defaultMetaDataUpdater,
    deepmerge: customizedDeepmerge,
    useImplicitDefaultMerging: options.enableImplicitDefaultMerging ?? false,
    filterValues: options.filterValues === false ? void 0 : options.filterValues ?? defaultFilterValues,
    actions
  };
}
function mergeUnknowns(values, utils, meta) {
  const filteredValues = utils.filterValues?.(values, meta) ?? values;
  if (filteredValues.length === 0) {
    return void 0;
  }
  if (filteredValues.length === 1) {
    return mergeOthers(filteredValues, utils, meta);
  }
  const type = getObjectType(filteredValues[0]);
  if (type !== 0 && type !== 5) {
    for (let mut_index = 1; mut_index < filteredValues.length; mut_index++) {
      if (getObjectType(filteredValues[mut_index]) === type) {
        continue;
      }
      return mergeOthers(filteredValues, utils, meta);
    }
  }
  switch (type) {
    case 1: {
      return mergeRecords(filteredValues, utils, meta);
    }
    case 2: {
      return mergeArrays(filteredValues, utils, meta);
    }
    case 3: {
      return mergeSets(filteredValues, utils, meta);
    }
    case 4: {
      return mergeMaps(filteredValues, utils, meta);
    }
    default: {
      return mergeOthers(filteredValues, utils, meta);
    }
  }
}
function mergeRecords(values, utils, meta) {
  const result = utils.mergeFunctions.mergeRecords(values, utils, meta);
  if (result === actions.defaultMerge || utils.useImplicitDefaultMerging && result === void 0 && utils.mergeFunctions.mergeRecords !== utils.defaultMergeFunctions.mergeRecords) {
    return utils.defaultMergeFunctions.mergeRecords(values, utils, meta);
  }
  return result;
}
function mergeArrays(values, utils, meta) {
  const result = utils.mergeFunctions.mergeArrays(values, utils, meta);
  if (result === actions.defaultMerge || utils.useImplicitDefaultMerging && result === void 0 && utils.mergeFunctions.mergeArrays !== utils.defaultMergeFunctions.mergeArrays) {
    return utils.defaultMergeFunctions.mergeArrays(values);
  }
  return result;
}
function mergeSets(values, utils, meta) {
  const result = utils.mergeFunctions.mergeSets(values, utils, meta);
  if (result === actions.defaultMerge || utils.useImplicitDefaultMerging && result === void 0 && utils.mergeFunctions.mergeSets !== utils.defaultMergeFunctions.mergeSets) {
    return utils.defaultMergeFunctions.mergeSets(values);
  }
  return result;
}
function mergeMaps(values, utils, meta) {
  const result = utils.mergeFunctions.mergeMaps(values, utils, meta);
  if (result === actions.defaultMerge || utils.useImplicitDefaultMerging && result === void 0 && utils.mergeFunctions.mergeMaps !== utils.defaultMergeFunctions.mergeMaps) {
    return utils.defaultMergeFunctions.mergeMaps(values);
  }
  return result;
}
function mergeOthers(values, utils, meta) {
  const result = utils.mergeFunctions.mergeOthers(values, utils, meta);
  if (result === actions.defaultMerge || utils.useImplicitDefaultMerging && result === void 0 && utils.mergeFunctions.mergeOthers !== utils.defaultMergeFunctions.mergeOthers) {
    return utils.defaultMergeFunctions.mergeOthers(values);
  }
  return result;
}

// ../ts-core/src/retrieve/RequestUnlimited.js
import ky, { HTTPError } from "ky";
import { serializeError as serializeError7 } from "serialize-error";

// ../ts-core/src/retrieve/RequestResponseSerialize.ts
import { serializeError as serializeError6 } from "serialize-error";

// ../ts-core/src/loggers/index.ts
var runtime = detectRuntime();
async function loadLogger() {
  let impl;
  switch (runtime) {
    case "cloudflare":
      impl = await import("./cloudflare-YI5WKCG4.js");
      break;
    case "aws-lambda":
      impl = await import("./lambda-I6EUS5A3.js");
      break;
    case "gcp-cloudrun":
      impl = await import("./gcp-QAOK3AQE.js");
      break;
    case "bun":
      impl = await import("./bun-3WRUWTNH.js");
      break;
    case "deno":
      impl = await import("./deno-EQDY3YRB.js");
      break;
    default:
      impl = await import("./node-DAZ46RSG.js");
      break;
  }
  const loggerRaw = impl.default;
  const logger8 = typeof loggerRaw === "function" ? loggerRaw() : loggerRaw;
  globalThis.logger = logger8;
  return logger8;
}
var loggers_default = await loadLogger();

// ../ts-core/src/retrieve/RequestResponseSerialize.ts
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
      error: serializeError6(error)
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

// ../ts-core/src/retrieve/RequestUnlimited.js
var customDeepmerge = deepmergeCustom({
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
        if (status === 429 && retryCount <= 5)
          return true;
        if (status >= 400 && status < 500)
          return false;
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
        const logger8 = globalThis.logger;
        logger8?.trace(`Retrying API call, retry count: ${retryCount}`);
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
async function endPoint5(url, options = {}) {
  const normalizedDefaultHeaders = toLowercaseKeys(DEFAULT_REQUEST_OPTIONS.headers || {});
  const normalizedInputHeaders = options.headers ? toLowercaseKeys(options.headers) : {};
  const { headers, hooks, ...remainingOptions } = options;
  const kyOptions = customDeepmerge(DEFAULT_REQUEST_OPTIONS, remainingOptions, {
    headers: { ...normalizedDefaultHeaders, ...normalizedInputHeaders },
    hooks: {
      beforeRetry: [
        ...DEFAULT_REQUEST_OPTIONS.hooks?.beforeRetry || [],
        ...hooks?.beforeRetry || []
      ]
    }
  });
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
      const logger9 = globalThis.logger;
      logger9?.warn("RequestUnlimited: HTTP Error", {
        status: errorResponse?.status,
        url: url.toString()
      });
      return {
        status: "error",
        reason: errorResponse
      };
    }
    const serializedError = serializeError7(error);
    const logger8 = globalThis.logger;
    logger8?.error("RequestUnlimited: Internal/Network Error", serializedError);
    return {
      status: "error",
      reason: serializedError
    };
  }
}

// src/nasdaq/MarketStatus.ts
import { ConfigManager as ConfigManager5, logger as logger6 } from "@ckir/corelib";
import { DateTime as DateTime4 } from "luxon";
import { serializeError as serializeError8 } from "serialize-error";
var DEFAULT_ENDPOINT = "https://api.nasdaq.com/api/market-info";
var ZONE = "America/New_York";
var marketStatusLogger = logger6.child({ section: "MarketStatus" });
function getSleepDuration(data) {
  const now = DateTime4.now().setZone(ZONE);
  if (data.mrktStatus === "Open") {
    return 0;
  }
  const pmOpen = DateTime4.fromISO(data.pmOpenRaw, {
    zone: ZONE
  });
  const marketOpen = DateTime4.fromISO(data.openRaw, {
    zone: ZONE
  });
  let target = now < pmOpen ? pmOpen : marketOpen;
  if (target <= now) {
    const nextTrade = DateTime4.fromFormat(data.nextTradeDate, "MMM d, yyyy", {
      zone: ZONE
    });
    if (nextTrade.isValid) {
      target = nextTrade.set({
        hour: 4,
        minute: 0,
        second: 0,
        millisecond: 0
      });
    } else {
      marketStatusLogger.warn("Failed to parse nextTradeDate", {
        date: data.nextTradeDate
      });
      return 300 * 1e3;
    }
  }
  if (target > now) {
    const diff = target.diff(now);
    marketStatusLogger.debug(
      `Target NY Open: ${target.toFormat("yyyy-MM-dd HH:mm:ss")} (${diff.toFormat("hh:mm:ss")} remaining)`
    );
    const ms = diff.as("milliseconds");
    return ms > 0 ? ms : 60 * 1e3;
  }
  return 60 * 1e3;
}
async function getStatus() {
  const endpoint = ConfigManager5.get("markets.nasdaq.statusEndpoint") ?? DEFAULT_ENDPOINT;
  try {
    const result = await ApiNasdaqUnlimited.endPoint(endpoint);
    if (result.status === "error") {
      const errorData = serializeError8(result.reason);
      const reasonSerialized = {
        ...errorData,
        message: errorData.message || "Nasdaq API returned an error status"
      };
      marketStatusLogger.error("Fetch Failed", {
        reason: reasonSerialized
      });
      return { status: "error", reason: reasonSerialized };
    }
    const data = result.value;
    if (!data?.mrktStatus || !data.nextTradeDate || !data.pmOpenRaw || !data.openRaw) {
      const msg = "STRICT SCHEMA VALIDATION FAILED: Missing required fields";
      const payload = serializeError8(data);
      marketStatusLogger.warn(msg, { payload });
      return {
        status: "error",
        reason: { message: msg, payload }
      };
    }
    marketStatusLogger.trace("Schema validated successfully");
    return {
      status: "success",
      value: data,
      details: result.details
    };
  } catch (e) {
    const errorData = serializeError8(e);
    const serializedReason = {
      ...errorData,
      message: errorData.message || "Unexpected MarketStatus Exception"
    };
    marketStatusLogger.error("Unexpected Error", {
      error: serializedReason
    });
    return {
      status: "error",
      reason: serializedReason
    };
  }
}
var MarketStatus = {
  /**
   * Fetches the current market status.
   */
  getStatus,
  /**
   * Calculates the sleep duration until next market phase.
   */
  getSleepDuration
};

// src/nasdaq/MarketMonitor.ts
var marketMonitorLogger = logger7.child({ section: "MarketMonitor" });
var DEFAULT_LIVE_INTERVAL_SEC = 10;
var DEFAULT_CLOSED_INTERVAL_SEC = 3600;
var DEFAULT_WARN_INTERVAL_SEC = 60;
var MarketMonitor = class extends EventEmitter4 {
  liveIntervalSec;
  closedIntervalSec;
  warnIntervalSec;
  proxies;
  proxyIndex = 0;
  timeoutId = null;
  isRunning = false;
  lastData = null;
  lastPhase = "closed";
  lastWarnTime = 0;
  failureCount = 0;
  hasEmitted = false;
  /**
   * @param {object} [options] - Configuration options.
   * @param {number} [options.liveIntervalSec] - Polling interval in seconds when market is active.
   * @param {number} [options.closedIntervalSec] - Polling interval in seconds when market is closed.
   * @param {number} [options.warnIntervalSec] - Interval for logging fetch failure warnings.
   * @param {string[]} [options.proxies] - Optional array of proxy URLs for status fetching.
   */
  constructor(options = {}) {
    super();
    this.liveIntervalSec = options.liveIntervalSec ?? ConfigManager6.get("markets.nasdaq.monitor.liveIntervalSec") ?? DEFAULT_LIVE_INTERVAL_SEC;
    this.closedIntervalSec = options.closedIntervalSec ?? ConfigManager6.get("markets.nasdaq.monitor.closedIntervalSec") ?? DEFAULT_CLOSED_INTERVAL_SEC;
    this.warnIntervalSec = options.warnIntervalSec ?? ConfigManager6.get("markets.nasdaq.monitor.warnIntervalSec") ?? DEFAULT_WARN_INTERVAL_SEC;
    this.proxies = (options.proxies || []).map(
      (p) => p.endsWith("/") ? `${p}api/v1/markets/nasdaq/status` : `${p}/api/v1/markets/nasdaq/status`
    );
  }
  /** Start the monitor. First emission happens only after the first successful poll. */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.failureCount = 0;
    marketMonitorLogger.info(
      `Starting market status monitor. Using ${this.proxies.length} proxies.`
    );
    this.poll();
  }
  /** Graceful shutdown. Clears timer and emits 'stopped'. */
  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    marketMonitorLogger.info("Monitor stopped");
    this.emit("stopped");
  }
  /** Current running state */
  get isRunningState() {
    return this.isRunning;
  }
  /** Last known phase (real or heuristic) */
  get currentPhase() {
    return this.lastPhase;
  }
  /** Last known full market data (null until first success) */
  get lastKnownData() {
    return this.lastData ? { ...this.lastData } : null;
  }
  /** Number of consecutive fetch failures (reset on success) */
  get failureCountValue() {
    return this.failureCount;
  }
  async poll() {
    if (!this.isRunning) return;
    let success = false;
    if (this.proxies.length > 0) {
      const startIdx = this.proxyIndex;
      for (let i = 0; i < this.proxies.length; i++) {
        const currentIdx = (startIdx + i) % this.proxies.length;
        const proxyUrl = this.proxies[currentIdx];
        try {
          const result = await endPoint5(proxyUrl);
          if (result.status === "success" && typeof result.value.body === "object" && result.value.body !== null) {
            const body = result.value.body;
            const data = body.value || body;
            if (data && typeof data === "object" && data.mrktStatus && data.openRaw) {
              this.handleSuccess(data);
              this.proxyIndex = (currentIdx + 1) % this.proxies.length;
              success = true;
              break;
            }
          }
          marketMonitorLogger.warn(
            "Proxy status fetch failed or returned unexpected format",
            { proxyUrl }
          );
        } catch (err) {
          marketMonitorLogger.error("Error fetching via proxy", {
            proxyUrl,
            error: serializeError9(err)
          });
        }
      }
    }
    if (!success) {
      try {
        const result = await MarketStatus.getStatus();
        if (result.status === "success") {
          this.handleSuccess(result.value);
          success = true;
        } else {
          this.handleFailure();
        }
      } catch (err) {
        marketMonitorLogger.error("Unexpected poll error", {
          error: serializeError9(err)
        });
        this.handleFailure();
      }
    }
    this.scheduleNextPoll();
  }
  handleSuccess(data) {
    this.failureCount = 0;
    this.lastData = { ...data };
    const phase = this.determinePhase(data);
    const phaseChanged = phase !== this.lastPhase;
    this.lastPhase = phase;
    if (!this.hasEmitted || phaseChanged) {
      this.emit("status-change", phase, { ...data }, false);
      this.hasEmitted = true;
    }
  }
  handleFailure() {
    this.failureCount++;
    if (!this.lastData) {
      this.maybeLogWarn();
      return;
    }
    const phase = this.determinePhase({ ...this.lastData, mrktStatus: "" });
    const phaseChanged = phase !== this.lastPhase;
    this.lastPhase = phase;
    const heuristicData = {
      ...this.lastData,
      mrktStatus: "",
      // Official status is no longer valid during heuristic calculation
      heuristic: true
    };
    if (phaseChanged) {
      this.emit("status-change", phase, heuristicData, true);
    }
    this.maybeLogWarn();
  }
  /**
   * Determine market phase.
   * 1. Try to normalize the official mrktStatus field first
   * 2. Fall back to precise time-based calculation using the four raw timestamps
   */
  determinePhase(data) {
    const rawStatus = (data.mrktStatus || "").toLowerCase().trim();
    if (rawStatus.includes("open") && !rawStatus.includes("after") && !rawStatus.includes("pre")) {
      return "open";
    }
    if (rawStatus.includes("pre") || rawStatus.includes("pre-market")) {
      return "pre-market";
    }
    if (rawStatus.includes("after") || rawStatus.includes("after-hours")) {
      return "after-hours";
    }
    if (rawStatus.includes("closed")) {
      return "closed";
    }
    const now = DateTime5.now().setZone("America/New_York");
    const pmOpen = DateTime5.fromISO(data.pmOpenRaw || "", {
      zone: "America/New_York"
    });
    const mOpen = DateTime5.fromISO(data.openRaw || "", {
      zone: "America/New_York"
    });
    const mClose = DateTime5.fromISO(data.closeRaw || "", {
      zone: "America/New_York"
    });
    const ahClose = DateTime5.fromISO(data.ahCloseRaw || "", {
      zone: "America/New_York"
    });
    if (!pmOpen.isValid || !mOpen.isValid) {
      return "closed";
    }
    if (now >= pmOpen && now < mOpen) return "pre-market";
    if (now >= mOpen && now < mClose) return "open";
    if (now >= mClose && now < ahClose) return "after-hours";
    return "closed";
  }
  scheduleNextPoll() {
    if (!this.isRunning) return;
    const intervalMs = this.getPollIntervalMs();
    this.timeoutId = setTimeout(() => this.poll(), intervalMs);
  }
  /**
   * Adaptive polling interval.
   * • No data yet → warnIntervalSec
   * • Has data → use liveIntervalSec or closedIntervalSec based on CURRENT (real or heuristic) phase
   */
  getPollIntervalMs() {
    if (!this.lastData) {
      return this.warnIntervalSec * 1e3;
    }
    const phase = this.determinePhase(this.lastData);
    return phase === "closed" ? this.closedIntervalSec * 1e3 : this.liveIntervalSec * 1e3;
  }
  maybeLogWarn() {
    const now = Date.now();
    if (now - this.lastWarnTime >= this.warnIntervalSec * 1e3) {
      marketMonitorLogger.warn(
        "MarketStatus fetch failed \u2013 using heuristic data",
        {
          failures: this.failureCount
        }
      );
      this.lastWarnTime = now;
    }
  }
};

// src/index.ts
var Markets = {
  /** Nasdaq-specific integrations. */
  nasdaq: {
    /** High-performance Nasdaq API wrapper. */
    ApiNasdaqUnlimited,
    /** Simple Nasdaq quote fetcher. */
    ApiNasdaqQuotes,
    /** Persistent Nasdaq symbol database. */
    MarketSymbols
  }
};
export {
  AlpacaStreaming,
  ApiNasdaqQuotes,
  ApiNasdaqUnlimited,
  CnnFearAndGreed,
  CnnFearAndGreedFilter,
  Historical,
  Luxon,
  MarketMonitor,
  MarketStatus,
  MarketSymbols,
  Markets,
  NasdaqPolling,
  YahooStreaming,
  getNasdaqHeaders,
  getSymbolsTop100
};
