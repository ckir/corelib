# corelib-rust

The high-performance native core for the Corelib monorepo, implemented in Rust and exposed to TypeScript via N-API (FFI).

## Features

- **Performance-Critical Logic**: Native implementation for CPU-intensive tasks and high-concurrency network operations.
- **Resilient Retrieval**: Robust HTTP client mirroring the TypeScript `ky` API, with advanced retry logic and load-balanced proxy support.
- **Financial Tooling**: Specialized modules for fetching and processing real-time market data from Nasdaq and Yahoo Finance.
- **Cross-Platform**: Prebuilt binaries for Windows, Linux, and macOS.
- **FFI Bridge**: Seamless integration with Node.js using `napi-rs`.

## Native Modules

### 1. Resilient Retrieve (`crate::retrieve`)
A set of high-level HTTP utilities designed for maximum reliability:
- **`ky`**: An ergonomic wrapper around `reqwest` that mimics the popular `ky` JS library, featuring automatic exponential backoff and `Retry-After` header support.
- **`unlimited`**: Standardized success/error result wrappers (`ApiResponse`) and parallel fetching capabilities.
- **`proxied`**: A load-balancing client that automatically rotates through a list of proxies, with built-in failure tracking and automatic removal of dead proxies.

### 2. Nasdaq API (`crate::markets::nasdaq`)
High-resilience wrappers for the official Nasdaq API:
- **`api_nasdaq_unlimited`**: Automatically injects requisite spoofed headers and performs deep validation of the Nasdaq-specific `rCode`.
- **`api_nasdaq_quotes`**: Concurrent bulk fetching of real-time and end-of-day quotes with symbol parsing and asset class mapping.

### 3. Yahoo Streaming Core (`crate::markets::nasdaq::datafeeds::streaming::yahoo`)
High-speed Yahoo Finance price stream handler using WebSockets and Protocol Buffers. Features silence detection, persistent subscriptions via `redb`, and supervised reconnection logic.

### 4. Nasdaq Polling Daemon (`src/bin/nasdaq_polling.rs`)
A native CLI binary that polls Nasdaq quotes based on complex cron schedules (inclusion/exclusion). Supports direct API calls or load-balanced execution via edge proxies.

### 5. General Utilities (`crate::utils`)
- **`include_exclude_cron`**: A multi-rule cron scheduler with second-level precision, mirroring the TypeScript implementation for unified task scheduling logic.

## Building & Development

### Prerequisites
- [Rust](https://rust-lang.org/) (Stable channel)
- `pnpm` (for `napi-rs` build scripts)

### Local Build
From the `rust/` directory:
```bash
# Build the native module (.node binary)
pnpm build
```

### Running Rust Tests
The Rust package includes an exhaustive test suite using `wiremock` for deterministic network testing.
```bash
cargo test
```

## CLI Binaries

The project includes several high-performance CLI binaries for standalone market data acquisition.

### 1. Yahoo Streamer (`yahoo_streamer`)
A supervised WebSocket client for Yahoo Finance. Outputs real-time pricing data as NDJSON to `stdout`.

> **Note**: `bid_price`, `bid_size`, `ask_price`, and `ask_size` fields may appear as `0.0` or `0` for many equity symbols. This is a limitation of the data provided by the Yahoo Finance WebSocket feed for those assets, not a bug in the implementation. These fields are correctly populated for other asset classes, such as cryptocurrency.

```bash
# Subscribe to multiple symbols with a 60s silence timeout
./target/release/yahoo_streamer --symbols "AAPL,MSFT,TSLA" --silence 60

# Specify a custom persistence database
./target/release/yahoo_streamer --db "./my_streamer.db" --symbols "AAPL"

# Run without any database persistence (ephemeral session)
./target/release/yahoo_streamer --noPersist --symbols "BTC-USD"

# Clear existing persistent subscriptions and start fresh
./target/release/yahoo_streamer --clean --symbols "QQQ,SPY"
```

### 2. Alpaca Streamer (`alpaca_streamer`)
A supervised WebSocket client for Alpaca Finance (IEX data stream). Outputs real-time pricing data as NDJSON to `stdout`.

```bash
# Subscribe to multiple symbols
./target/release/alpaca_streamer --symbols "AAPL,MSFT"

# Provide API credentials via CLI (overrides environment variables)
./target/release/alpaca_streamer --key "YOUR_KEY" --secret "YOUR_SECRET" --symbols "TSLA"

# Run without database persistence
./target/release/alpaca_streamer --noPersist --symbols "NVDA"
```

### 3. Nasdaq Polling Daemon (`nasdaq_polling`)
A cron-driven daemon for polling the official Nasdaq API. Supports load-balancing via multiple edge proxies.

```bash
# Poll every second during market hours, excluding weekends
./target/release/nasdaq_polling \
  --include "* * * * * * *" \
  --exclude "* * * * * 0,6 *" \
  --symbol "AAPL::stocks" \
  --symbol "QQQ::etf" \
  --concurrency 10

# Poll via ts-cloud edge proxies for enhanced resilience
./target/release/nasdaq_polling \
  --include "*/5 * * * * * *" \
  --symbol "MSFT::stocks" \
  --proxy "https://ts-cloud.costas.workers.dev/" \
  --proxy "https://vk2hdy5skibvncgvbqwrnxvlvu0idgat.lambda-url.us-east-1.on.aws/"
```

> **Cron semantics (changed with the `cron` → `croner` migration).** Schedules are
> evaluated in **UTC** and follow the same `croner` rules as `ts-core`'s
> `includeExcludeCron`:
>
> - **Day of week is POSIX-numbered**: `0`/`7` = Sunday, `1` = Monday … `6` = Saturday.
>   The previous `cron` 0.16 backend used Quartz numbering (`1` = Sunday … `7` = Saturday)
>   and **rejected `0` outright**, so the `--exclude "* * * * * 0,6 *"` example above never
>   ran — it exits immediately with a discarded error. It is correct now.
> - **Day-of-month and day-of-week combine with OR** (Vixie default): `0 0 0 1 * MON`
>   fires on the 1st *or* on any Monday. Prefix the day-of-week field with `+`
>   (`0 0 0 1 * +MON`) to require both. The previous backend required both.
> - **5-, 6- and 7-field patterns are accepted**; a 5-field pattern is read as having
>   seconds `0`. The previous backend accepted only 6- and 7-field patterns.
> - **Now rejected** (both were accepted by the previous backend): full weekday names
>   such as `SUNDAY`/`TUES` — use 3-letter `SUN`/`TUE` — and single-number steps such as
>   `0/10` — use `*/10` or `0-59/10`.
>
> An invalid expression now exits with status **1** and an error on `stderr`, instead of
> printing `Daemon started successfully.` and exiting 0 without ever polling.

## Internal Usage (via FFI)

The native functions are typically accessed through the `Core` object in `@ckirg/corelib`:

```typescript
import { Core } from '@ckirg/corelib';

// Guard before use — FFI is disabled on Cloudflare Workers
if (Core.isFfiAvailable()) {
  // Get the native library version
  const version = Core.getVersion();
  console.log(`Rust Core Version: ${version}`);

  // Call a data processing function: logs in Rust and returns the doubled value
  const doubled = Core.logAndDouble("Testing...", 21);
  console.log(doubled); // 42
}
```

## CI/CD and Release

Binaries are automatically built for multiple architectures (Darwin x64/arm64, Linux x64, Win x64) during the release process and bundled with the `@ckirg/corelib` package.
