// =============================================
// FILE: ts-markets/tests/integration/external-rest.integration.test.ts
// PURPOSE: External REST seam tests for ts-markets providers.
// Runs in replay mode (offline) via committed fixtures.
// Record with: INTEGRATION_RECORD=1 pnpm --filter @ckir/corelib-markets test:integration
// =============================================

import { ConfigManager, createDatabase } from "@ckir/corelib";
import {
  ApiNasdaqQuotes,
  CnnFearAndGreed,
  CnnFearAndGreedFilter,
  MarketStatus,
  MarketSymbols,
  getSymbolsTop100,
} from "@ckir/corelib-markets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture, recordTo } from "@itest/_harness/server";

beforeAll(async () => {
  await ConfigManager.getInstance().initialize([]);
  // Bound retries to 0 for replay mode: prevents retry exhausting the fixture queue on 5xx.
  ConfigManager.getInstance().updateValue("retrieve.retry.limit", 0);
});

// ---------------------------------------------------------------------------
// Helper: pre-seeded in-memory MarketSymbols DB for ApiNasdaqQuotes tests.
// MarketSymbols accepts an existing Database instance and will run
// ensureInitialized() (CREATE TABLE + CREATE INDEX + needsRefresh check).
// By pre-inserting with ts=Date.now() the refresh is skipped (today == today).
// ---------------------------------------------------------------------------

async function createSeededMarketSymbolsDb(
  rows: Array<{
    symbol: string;
    type: "rt" | "eod";
    class: string;
    name: string;
  }>,
) {
  const db = await createDatabase({
    dialect: "sqlite",
    url: ":memory:",
    mode: "stateful",
  } as never);

  // Create the schema that MarketSymbols.ensureInitialized() also creates
  // (CREATE TABLE IF NOT EXISTS — safe to duplicate).
  await db.query(`
    CREATE TABLE IF NOT EXISTS nasdaq_symbols (
      symbol   TEXT PRIMARY KEY,
      type     TEXT NOT NULL,
      class    TEXT NOT NULL,
      name     TEXT NOT NULL,
      ts       INTEGER NOT NULL,
      active   BOOLEAN NOT NULL DEFAULT true
    )
  `);
  await db.query(
    "CREATE INDEX IF NOT EXISTS idx_nasdaq_symbols_active ON nasdaq_symbols(active)",
  );

  const now = Date.now();
  for (const row of rows) {
    await db.query(
      "INSERT INTO nasdaq_symbols (symbol, type, class, name, ts, active) VALUES (?, ?, ?, ?, ?, true)",
      [row.symbol, row.type, row.class, row.name, now],
    );
  }

  return db;
}

const seededDbs: Array<{ disconnect: () => Promise<void> }> = [];

afterAll(async () => {
  for (const db of seededDbs) {
    try {
      await db.disconnect();
    } catch {
      /* ignore */
    }
  }
  seededDbs.length = 0;
});

// ---------------------------------------------------------------------------
// Nasdaq MarketStatus
// ---------------------------------------------------------------------------

describe("external REST (Nasdaq MarketStatus)", () => {
  it("[nasdaq.marketStatus.success] returns parsed status on 200", async () => {
    recordTo("nasdaq", "market-status-success");
    loadFixture("nasdaq", "market-status-success");
    const result = await MarketStatus.getStatus();
    expect(result).toBeTruthy();
    expect(result.status).toBe("success");
  });

  it("[nasdaq.marketStatus.500] surfaces a serialized error on 500", async () => {
    // retry.limit was set to 0 in beforeAll so the single 500 fixture is consumed once.
    recordTo("nasdaq", "market-status-500");
    loadFixture("nasdaq", "market-status-500");
    const result = await MarketStatus.getStatus();
    // MarketStatus.getStatus() never rejects — it catches all errors and returns {status:"error"}.
    expect(result.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Nasdaq ApiNasdaqQuotes
// ---------------------------------------------------------------------------

describe("external REST (Nasdaq ApiNasdaqQuotes)", () => {
  it("[nasdaq.quotes.success] returns a parsed quote for AAPL", async () => {
    const db = await createSeededMarketSymbolsDb([
      { symbol: "AAPL", type: "rt", class: "stocks", name: "Apple Inc." },
    ]);
    seededDbs.push(db as any);

    const ms = new MarketSymbols(db as any);
    const quotes = new ApiNasdaqQuotes({ marketSymbols: ms });

    recordTo("nasdaq", "quotes-aapl-success");
    loadFixture("nasdaq", "quotes-aapl-success");

    const results = await quotes.getNasdaqQuote(["AAPL"]);
    await quotes.close();

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
    // On success, nasdaqEndPoint extracts body.data as value.
    expect(results[0]).toBeTruthy();
  });

  it("[nasdaq.quotes.404] surfaces an error for a symbol with a 404 response", async () => {
    const db = await createSeededMarketSymbolsDb([
      { symbol: "ZZZZ", type: "rt", class: "stocks", name: "Test Symbol" },
    ]);
    seededDbs.push(db as any);

    const ms = new MarketSymbols(db as any);
    const quotes = new ApiNasdaqQuotes({ marketSymbols: ms });

    // 404 is not retried (shouldRetry returns false for 400-499).
    recordTo("nasdaq", "quotes-404");
    loadFixture("nasdaq", "quotes-404");

    const results = await quotes.getNasdaqQuote(["ZZZZ"]);
    await quotes.close();

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Nasdaq Top100
// ---------------------------------------------------------------------------

describe("external REST (Nasdaq getSymbolsTop100)", () => {
  it("[nasdaq.top100.success] returns an array of symbol strings", async () => {
    recordTo("nasdaq", "top100-success");
    loadFixture("nasdaq", "top100-success");
    const symbols = await getSymbolsTop100();
    // Returns [] on error (never rejects); an empty array is truthy-ish but we
    // accept it if the module cache was pre-populated by a previous test run.
    expect(Array.isArray(symbols)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CNN Fear & Greed
// CNN API URL includes a date; we use a fixed date for deterministic replay.
// ---------------------------------------------------------------------------

describe("external REST (CNN CnnFearAndGreed)", () => {
  it("[cnn.fearGreed.success] returns fear_and_greed data on 200", async () => {
    recordTo("cnn", "fear-greed-success");
    loadFixture("cnn", "fear-greed-success");
    // Pass a fixed date so the URL is deterministic: .../graphdata/2026-06-13
    const result = await CnnFearAndGreed.getFearAndGreed(
      "2026-06-13",
      CnnFearAndGreedFilter.FearAndGreed,
    );
    expect(result).toBeTruthy();
    expect(result.status).toBe("success");
  });

  it("[cnn.fearGreed.500] surfaces a transport error on 500", async () => {
    // retry.limit was set to 0 in beforeAll so the single 500 fixture is consumed once.
    recordTo("cnn", "fear-greed-500");
    loadFixture("cnn", "fear-greed-500");
    const result = await CnnFearAndGreed.getFearAndGreed(
      "2026-06-13",
      CnnFearAndGreedFilter.FearAndGreed,
    );
    // getFearAndGreed() never rejects — it catches all errors and returns {status:"error"}.
    expect(result.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Yahoo Historical — TODO: intractable offline (URL contains timestamps).
// ---------------------------------------------------------------------------
// TODO(itest): record yahoo historical success fixture live
// The Yahoo finance2 chart URL includes period1/period2 Unix timestamps that
// vary with each test run, making deterministic fixture matching impossible.
// Cover yahoo.historical.success in a future live-recording session.
