# @ckir/corelib-markets

Market data and financial utilities for the Corelib monorepo.

## Features

- **Market Data**: Tools for retrieving and processing financial data.
- **Optional Dependency**: Built upon `@ckir/corelib`.

## Installation

```bash
pnpm add @ckir/corelib-markets
```

## Usage Example

```typescript
import { Markets } from '@ckir/corelib-markets';
```

## Nasdaq API Wrapper

High-resilience wrapper for Nasdaq APIs with custom headers and response verification.

```typescript
import { ApiNasdaqUnlimited } from '@ckir/corelib-markets';

// Single request
const result = await ApiNasdaqUnlimited.endPoint('https://api.nasdaq.com/api/some/endpoint');

if (result.status === 'success') {
  console.log('Data:', result.value);
} else {
  console.error('Error:', result.reason.message);
}

// Parallel requests
const results = await ApiNasdaqUnlimited.endPoints(['https://api.nasdaq.com/api/endpoint1', 'https://api.nasdaq.com/api/endpoint2']);
```

// Append to ts-markets/README.md

### Market Status

Fetch current Nasdaq market status and calculate sleep duration until next open.

```typescript
import { MarketStatus } from '@ckir/corelib-markets';

const status = await MarketStatus.getStatus();

if (status.status === 'success') {
  console.log('Market Status:', status.value.mrktStatus);
  const sleepMs = MarketStatus.getSleepDuration(status.value);
  console.log('Sleep until next open (ms):', sleepMs);
} else {
  console.error('Error:', status.reason.message);
}
```

### CNN Fear & Greed Index

Retrieve the CNN Fear & Greed Index with optional date and client-side filtering.

```typescript
import { CnnFearAndGreed, CnnFearAndGreedFilter } from '@ckir/corelib-markets';

// Fetch current Fear & Greed Index
const result = await CnnFearAndGreed.getFearAndGreed();

// Fetch for specific date with filter
const historical = await CnnFearAndGreed.getFearAndGreed(
  "2026-03-15", 
  CnnFearAndGreedFilter.MarketVolatilityVix
);

if (result.status === 'success') {
  console.log('Fear & Greed:', result.value);
}
```

### Yahoo Real-Time Streaming (Rust-powered)

```ts
import { YahooStreaming } from '@ckir/corelib-markets';

const stream = new YahooStreaming();

await stream.init({ silenceSeconds: 45 });
await stream.start();

stream.subscribe(["AAPL", "TSLA"]);

stream.on("pricing", (data) => console.log("PRICE", data));
stream.on("log", (r) => globalThis.logger?.info(r.msg, r.extras));
stream.on("silence-reconnect", () => console.log("Reconnecting after silence"));
```
