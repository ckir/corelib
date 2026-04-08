# @ckir/corelib-markets

Financial market utilities and data providers for the Corelib monorepo, featuring high-resilience wrappers for Nasdaq and real-time streaming via Yahoo Finance.

## Features

- **Nasdaq API Wrapper**: Resilient requests with custom headers and error handling.
- **Market Status & Scheduling**: Intelligent pollers and sleep-calculators based on market phases.
- **Market Monitor**: Adaptive poller with heuristic fallback during API failures.
- **CNN Fear & Greed Index**: Retrieval and filtering of the popular sentiment indicator.
- **Yahoo Real-Time Streaming**: High-performance ticker streaming powered by Rust FFI.
- **Market Symbols**: Persistent symbol database with auto-refresh and environment-aware search sequencing.

## Installation

```bash
pnpm add @ckir/corelib-markets
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

### 4. Yahoo Real-Time Streaming (FFI)
High-performance ticker updates using the Rust bridge. Requires `@ckir/corelib` with FFI support.

```ts
import { YahooStreaming } from '@ckir/corelib-markets';

const stream = new YahooStreaming();

// Initialize with a 45s silence threshold before auto-reconnect
await stream.init({ silenceSeconds: 45 });
await stream.start();

// Subscribe to multiple symbols
stream.subscribe(["AAPL", "TSLA", "NVDA", "BTC-USD"]);

stream.on("pricing", (data) => {
  console.log(`Price Update: ${data.symbol} = ${data.price}`);
});

stream.on("silence-reconnect", () => {
  console.log("Yahoo stream silent for too long, reconnecting...");
});

// Clean up temporary session data (runs automatically in development mode)
stream.clean();

// Stop the stream
stream.stop();
```

### 5. Persistent Symbol Database (MarketSymbols)
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

### 6. Resilient Nasdaq API
Low-level wrapper for custom Nasdaq API interactions.

```typescript
import { ApiNasdaqUnlimited } from '@ckir/corelib-markets';

// Execute single high-resilience request
const result = await ApiNasdaqUnlimited.endPoint('https://api.nasdaq.com/api/quote/AAPL/info');

if (result.status === 'success') {
  console.log('AAPL Info:', result.value);
}
```

### 7. Integration with Core (Logging & Config)
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
