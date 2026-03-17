# corelib-rust

The high-performance native core for the Corelib monorepo, implemented in Rust and exposed to TypeScript via N-API (FFI).

## Features

- **Performance-Critical Logic**: Native implementation for CPU-intensive tasks.
- **Financial Tooling**: Specialized modules for market data processing (Nasdaq, Yahoo).
- **Cross-Platform**: Prebuilt binaries for Windows, Linux, and macOS.
- **FFI Bridge**: Seamless integration with Node.js using `napi-rs`.

## Native Modules

### 1. Yahoo Streaming Core
High-speed Yahoo Finance price stream handler using WebSocket and Protocol Buffers. This is the engine behind `@ckir/corelib-markets`'s `YahooStreaming`.

### 2. General Utilities
Native helpers for cron scheduling, timestamp manipulation, and mathematical operations used across the monorepo.

## Building & Development

### Prerequisites
- [Rust](https://rust-lang.org/) (Stable channel)
- `npm` or `pnpm` (for `napi-rs` build scripts)

### Local Build
From the `rust/` directory:
```bash
# Build the native module (.node binary)
pnpm build
```

### Running Rust Tests
```bash
cargo test
```

## Internal Usage (via FFI)

The native functions are typically accessed through the `Core` class in `@ckir/corelib`:

```typescript
import { Core } from '@ckir/corelib';

// Example: Calling the version helper from Rust
const version = Core.run("get_version");
console.log(`Rust Core Version: ${version}`);

// Example: Calling a data processing function
const doubled = Core.run("log_and_double", "Testing...", 21);
console.log(doubled); // 42
```

## CI/CD and Release

Binaries are automatically built for multiple architectures (Darwin x64/arm64, Linux x64, Win x64) during the release process and bundled with the `@ckir/corelib` package.
