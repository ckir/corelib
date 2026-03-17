# @ckir/corelib-markets

Financial market utilities and data providers for the Corelib monorepo, featuring high-resilience wrappers for Nasdaq and real-time streaming via Yahoo Finance.

## Features

- **Nasdaq API Wrapper**: Resilient requests with custom headers and error handling.
- **Market Status & Scheduling**: Intelligent pollers and sleep-calculators based on market phases.
- **Market Monitor**: Adaptive poller with heuristic fallback during API failures.
- **CNN Fear & Greed Index**: Retrieval and filtering of the popular sentiment indicator.
- **Yahoo Real-Time Streaming**: High-performance ticker streaming powered by Rust FFI.

## Installation

```bash
pnpm add @ckir/corelib-markets
```

## Usage Examples

### 1. Market Monitor (Resilient Status Poller)
Intelligent long-running task that adapts to market hours and handles failures gracefully.

```typescript
import { MarketMonitor, type MarketPhase } from '@ckir/corelib-markets';

const monitor = new MarketMonitor({
  liveIntervalSec: 15,      // Frequency when market is open
  closedIntervalSec: 1800,  // Frequency when market is closed
  warnIntervalSec: 60       // Warning throttle
});

monitor.on("status-change", (phase: MarketPhase, data, heuristic) => {
  console.log(`Current phase: ${phase}`);
  console.log(`Is heuristic (using fallback data): ${!!heuristic}`);
  console.log('Full Market Data:', data);
});

monitor.on("stopped", () => {
  console.log("Monitor gracefully stopped.");
});

monitor.start();

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
  
  // Calculate milliseconds until next open or pre-market
  const sleepMs = MarketStatus.getSleepDuration(info);
  console.log(`Sleeping ${sleepMs}ms until next event.`);
}
```

### 3. CNN Fear & Greed Index
Retrieve sentiment data with optional historical filtering.

```typescript
import { CnnFearAndGreed, CnnFearAndGreedFilter } from '@ckir/corelib-markets';

// Fetch current Fear & Greed Index
const current = await CnnFearAndGreed.getFearAndGreed();

// Fetch historical score for specific date with filter
const voldata = await CnnFearAndGreed.getFearAndGreed(
  "2026-03-15", 
  CnnFearAndGreedFilter.MarketVolatilityVix
);

if (current.status === 'success') {
  console.log(`Score: ${current.value.score} (${current.value.rating})`);
}
```

### 4. Yahoo Real-Time Streaming (FFI)
High-performance ticker updates using the Rust bridge.

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
```

### 5. Resilient Nasdaq API
Low-level wrapper for custom Nasdaq API interactions.

```typescript
import { ApiNasdaqUnlimited } from '@ckir/corelib-markets';

// Execute single high-resilience request
const result = await ApiNasdaqUnlimited.endPoint('https://api.nasdaq.com/api/quote/AAPL/info');

if (result.status === 'success') {
  console.log('AAPL Info:', result.value);
}
```
