# @ckir/corelib-markets

Financial market utilities and data providers for the Corelib monorepo, featuring high-resilience wrappers for Nasdaq and real-time streaming via Alpaca, Finnhub, and Yahoo Finance.

> [!IMPORTANT]
> Not on the public npm registry — install from GitHub Releases. See the [root install guide](../README.md#-installation-for-external-projects).

## Features

- **Nasdaq API Wrapper**: Resilient requests with custom headers and error handling.
- **Market Status & Scheduling**: Intelligent pollers and sleep-calculators based on market phases.
- **Market Monitor**: Adaptive poller with heuristic fallback during API failures.
- **CNN Fear & Greed Index**: Retrieval and filtering of the popular sentiment indicator.
- **Nasdaq 100 Symbols**: Fast, cached access to the Nasdaq 100 constituent symbols.
- **Real-Time Streaming**: Zero event-loop-blocking live feeds via Alpaca, Finnhub, and Yahoo Finance — the Rust WebSocket engine delivers data to JS via napi `ThreadsafeFunction`.
- **Market Symbols**: Persistent symbol database with auto-refresh and environment-aware search sequencing.

## Installation

Install from the GitHub Release — see the [root install guide](../README.md#-installation-for-external-projects) for package manager overrides (required because `@ckir/corelib` is a peer dependency also not on npm).

```bash
# pnpm
pnpm add https://github.com/ckir/corelib/releases/download/v0.1.17/ckir-corelib-markets-0.1.17.tgz
```

## Usage Examples

### 1. Market Monitor (Resilient Status Poller)
Intelligent long-running task that adapts to market hours and handles failures gracefully. It emits events only on market phase changes or after the first successful poll.

```typescript
import { MarketMonitor, type MarketPhase } from '@ckir/corelib-markets';

const monitor = new MarketMonitor({
  liveIntervalSec: 15,      // Frequency when market is open
  closedIntervalSec: 1800,  // Frequency when market is closed
  warnIntervalSec: 60       // Warning throttle during failures
});

// Emits on first successful poll and whenever the market phase (open/closed/pre/after) changes
monitor.on("status-change", (phase: MarketPhase, data, heuristic) => {
  console.log(`Current phase: ${phase}`);
  console.log(`Is heuristic (using fallback data due to fetch failure): ${!!heuristic}`);
  console.log('Full Market Data:', data);
});

monitor.on("stopped", () => {
  console.log("Monitor gracefully stopped.");
});

monitor.start();

// Check current state
console.log('Is Running:', monitor.isRunningState);
console.log('Current Phase:', monitor.currentPhase);

// Later...
// monitor.stop();
```

### 2. Nasdaq Market Status & Sleep Calculation
Direct retrieval and wait-time calculation.

```typescript
import { MarketStatus } from '@ckir/corelib-markets';

const result = await MarketStatus.getStatus();

if (result.status === 'success') {
  const info = result.value;
  console.log(`Nasdaq Status: ${info.mrktStatus}`);
  
  // Calculate milliseconds until next open or pre-market (returns 0 if already open)
  const sleepMs = MarketStatus.getSleepDuration(info);
  console.log(`Sleeping ${sleepMs}ms until next event.`);
}
```

### 3. CNN Fear & Greed Index
Retrieve sentiment data with optional historical filtering.

```typescript
import { CnnFearAndGreed, CnnFearAndGreedFilter } from '@ckir/corelib-markets';

// Fetch current Fear & Greed Index (returns the 'fear_and_greed' sub-object by default)
const current = await CnnFearAndGreed.getFearAndGreed();

// Fetch historical scores (full 1-year data)
const historical = await CnnFearAndGreed.getFearAndGreed("Historical", "full");

// Fetch specific metric for a specific date
const vix = await CnnFearAndGreed.getFearAndGreed(
  "2026-03-15", 
  CnnFearAndGreedFilter.MarketVolatilityVix
);

if (current.status === 'success') {
  console.log(`Score: ${current.value.score} (${current.value.rating})`);
}
```

### 4. Historical Data (Yahoo Finance v3)
Retrieve standardized historical OHLCV data using a resilient Yahoo Finance v3 integration.

```typescript
import { Historical } from '@ckir/corelib-markets';

// Fetch daily historical data for the last year
const result = await Historical.getData("AAPL", {
  period1: "2023-01-01",
  interval: "1d"
});

if (result.status === 'success') {
  console.log(`Retrieved ${result.value.length} quotes for ${result.value[0].symbol}`);
  const latest = result.value[result.value.length - 1];
  console.log(`Latest Close (${latest.date}): ${latest.close}`);
}
```

### 5. Real-Time Streaming (Rust WS Engine)

The flagship feature of `@ckir/corelib-markets`. All three streaming providers share the same architecture:

**Architecture:** The Rust crate owns the WebSocket connection. Data arrives on a Rust worker thread and is forwarded to JS via napi `ThreadsafeFunction` — the JS event loop is never blocked. Each wrapper is a standard Node.js `EventEmitter`. Construction is synchronous (calls into the native addon); `init()` + `start()` are async. Wrap `new XxxStreaming()` in `try/catch`.

#### Alpaca (authenticated; IEX real-time feed)

```typescript
import { AlpacaStreaming } from '@ckir/corelib-markets';

const stream = new AlpacaStreaming();

// Credentials via init() or APCA_API_KEY_ID / APCA_API_SECRET_KEY env vars
await stream.init({
  keyId: 'YOUR_KEY',
  secretKey: 'YOUR_SECRET',
  silenceSeconds: 60,   // auto-reconnect after N seconds of silence (default: 60)
  // dbPath: '/tmp/alpaca.redb'  // optional: override persistence DB path
});

await stream.start();

// Simple array → mapped to quotes channel; or pass { trades?, quotes?, bars? }
stream.subscribe(['AAPL', 'TSLA', 'NVDA']);

stream.on('pricing', (data) => {
  console.log(`${data.symbol}: $${data.price}`);
});
stream.on('market',       (event) => console.log('market event', event));
stream.on('connected',    ()      => console.log('connected'));
stream.on('disconnected', ()      => console.log('disconnected'));
stream.on('reconnecting', ()      => console.log('reconnecting'));
stream.on('log',          (r)     => console.log(`[${r.level}] ${r.msg}`));
stream.on('error',        (e)     => console.error('error', e));

// stream.unsubscribe(['AAPL']);
// stream.clean();   // wipe persistence DB (auto-runs in development mode)
stream.stop();
```

#### Finnhub (authenticated; token required)

```typescript
import { FinnhubStreaming, type FinnhubPricingData } from '@ckir/corelib-markets';

const stream = new FinnhubStreaming();

// Token via init() or FINNHUB_API_KEY env var
await stream.init({
  token: 'YOUR_FINNHUB_API_KEY',
  // name?: string     — optional label
  // baseUrl?: string  — override WS endpoint
});

await stream.start();

await stream.subscribe(['AAPL', 'MSFT', 'NVDA']);

stream.on('pricing', (data: FinnhubPricingData) => {
  // Payload fields are camelCase in JS (napi convention): messageType, not message_type.
  // data.timestamp is a numeric epoch in milliseconds.
  console.log(`[${data.messageType}] ${data.symbol}: $${data.price} @ ${data.timestamp}`);
});
stream.on('connected',    () => console.log('connected'));
stream.on('disconnected', (r) => console.log('disconnected', r));
stream.on('reconnecting', (d) => console.log('reconnecting', d));
stream.on('log',          (r) => console.log(`[${r.level}] ${r.msg}`));
stream.on('error',        (e) => console.error('error', e));

await stream.stop();
```

#### Yahoo Finance (unauthenticated)

```typescript
import { YahooStreaming } from '@ckir/corelib-markets';

const stream = new YahooStreaming();

await stream.init({
  silenceSeconds: 45,   // auto-reconnect threshold (default: 60)
  // dbPath: '/tmp/yahoo_streaming.redb'
});

await stream.start();

stream.subscribe(['AAPL', 'TSLA', 'NVDA', 'BTC-USD']);

// Yahoo's raw payload is the proto-decoded JsPricingData: the ticker is `id` (not `symbol`).
stream.on('pricing',          (data) => console.log(`${data.id}: $${data.price}`));
stream.on('silence-reconnect', ()    => console.log('silent too long, reconnecting'));
stream.on('connected',         ()    => console.log('connected'));
stream.on('disconnected',      ()    => console.log('disconnected'));
stream.on('error',             (e)   => console.error('error', e));

// stream.clean();   // wipe persistence DB (auto-runs in development mode)
stream.stop();
```

**Events emitted by all three:** `pricing`, `log` (`{level, msg, extras?}`), `connected`, `disconnected`, `reconnecting`, `error`. Alpaca/Yahoo also emit `market` (unified market event, parsed JSON object) and `silence-reconnect`.

### 6. Nasdaq 100 Symbols
Fast, cached retrieval of the Nasdaq 100 constituent symbols.

```typescript
import { getSymbolsTop100 } from '@ckir/corelib-markets';

const symbols = await getSymbolsTop100();
console.log(`Nasdaq 100 constituents (${symbols.length}):`, symbols);
```

### 7. Persistent Symbol Database (MarketSymbols)
Automated Nasdaq symbol directory with auto-refresh and environment-aware search sequencing.

#### Features
- **Auto-Refresh**: Synchronizes with official Nasdaq directories (`nasdaqlisted.txt`, `otherlisted.txt`) if data is missing or outdated (older than today NY time).
- **Environment-Aware**: Automatically optimizes search sequence based on the runtime:
  - **Standard (Node/Bun)**: `SQLite -> Nasdaq API -> Ingestors` (Prioritizes local speed).
  - **Edge (Cloudflare/Lambda)**: `Nasdaq API -> Ingestors -> SQLite` (Prioritizes fresh API data over cold storage).
- **Turso Support**: Supports both local SQLite and remote Turso/LibSQL databases.

#### Basic Usage
```typescript
import { MarketSymbols } from '@ckir/corelib-markets';

// Initialize (defaults to local SQLite: ./tmp/NasdaqSymbols.sqlite)
const symbols = new MarketSymbols();

// Get details (Sequence depends on runtime)
const aapl = await symbols.get("AAPL");
```

#### Cloud Usage (Turso)
```typescript
const symbols = new MarketSymbols({
  dbUrl: "libsql://your-db.turso.io",
  dbToken: "your-auth-token"
});
```

#### Custom Ingestors (e.g., Google Apps Script)
The ingestor should return a `MarketSymbolRow` JSON structure.

```typescript
const ingestorUrl = "https://script.google.com/macros/s/.../exec";
const symbols = new MarketSymbols(undefined, [ingestorUrl]);

// Fallback search will hit the GAS endpoint if not found in DB or Nasdaq API
const custom = await symbols.get("PRIVATE_TICKER");
```

#### Manual Maintenance
```typescript
// Force a full directory refresh from Nasdaq sources
await symbols.refresh();

// Graceful shutdown
await symbols.close();
```

### 8. Resilient Nasdaq API
Low-level wrapper for custom Nasdaq API interactions.

```typescript
import { ApiNasdaqUnlimited } from '@ckir/corelib-markets';

// Execute single high-resilience request
const result = await ApiNasdaqUnlimited.endPoint('https://api.nasdaq.com/api/quote/AAPL/info');

if (result.status === 'success') {
  console.log('AAPL Info:', result.value);
}
```

### 9. Integration with Core (Logging & Config)
`ts-markets` is designed to seamlessly use the logging and configuration systems provided by `@ckir/corelib`.

```typescript
import { logger, ConfigManager } from '@ckir/corelib';
import { MarketMonitor } from '@ckir/corelib-markets';

// The monitor automatically uses the global logger
const monitor = new MarketMonitor();

// You can override default headers via ConfigManager
// markets.nasdaq.headers
// markets.cnn.headers

logger.info("Starting market services...");
monitor.start();
```
