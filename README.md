# Corelib Monorepo

A high-performance, resilient, and multi-runtime monorepo for TypeScript and Rust. This workspace provides foundational utilities, cloud extensions, and financial market tooling designed for Node.js, Bun, and Deno.

## 🚀 Overview

This repository is structured as a pnpm monorepo, integrating TypeScript's flexibility with Rust's performance through FFI (Foreign Function Interface). It is built on principles of resilience, performance, and cross-runtime compatibility.

### Key Features
- **Isomorphic Core**: All foundational utilities in `ts-core` support Node.js, Bun, and Deno.
- **Resilient HTTP**: Standardized fetch wrapper (`RequestUnlimited`) with automatic retries and consistent error serialization.
- **Strict Logging**: Structured logging API with `(msg: string, extras?: object)` signature and telemetry support.
- **Native Performance**: Performance-critical paths implemented in Rust via N-API/FFI.
- **Unified Configuration**: Centralized `ConfigManager` supporting overrides via files, environment variables, and CLI.

---

## 📂 Project Structure

```text
corelib/
├── ts-core/      # (@ckir/corelib) Base logic, FFI, logging, and resilient HTTP.
├── ts-cloud/     # (@ckir/corelib-cloud) Cloud-specific extensions.
├── ts-markets/   # (@ckir/corelib-markets) Market data tooling (Nasdaq, Yahoo).
├── rust/         # (corelib-rust) Native Rust core exposed via N-API.
├── .gemini/      # AI agent configuration and mandates.
├── biome.json    # Monorepo-wide linting and formatting (Biome).
└── package.json  # Root workspace configuration.
```

---

## 📦 Installation for External Projects

Since these packages are not published to the public NPM registry, you can install them directly from the GitHub Release assets.

### 1. Install via Direct URL (Recommended)
You can point your package manager directly to the `.tgz` file in the GitHub Release. Replace `v0.1.6` with the desired version.

```bash
# Using pnpm
pnpm add https://github.com/ckir/corelib/releases/download/v0.1.6/ckir-corelib-0.1.6.tgz
pnpm add https://github.com/ckir/corelib/releases/download/v0.1.6/ckir-corelib-markets-0.1.6.tgz

# Using npm
npm install https://github.com/ckir/corelib/releases/download/v0.1.6/ckir-corelib-0.1.6.tgz
```

### ⚠️ Important: Handling Internal Dependencies
Because `@ckir/corelib-markets` depends on `@ckir/corelib`, and neither is on NPM, your package manager might try to find `@ckir/corelib` on the public registry and fail (404). 

To fix this, add an **override** to your `package.json` so the manager knows to use the specific version for the sub-dependency:

**For pnpm (`package.json`):**
```json
"pnpm": {
  "overrides": {
    "@ckir/corelib": "https://github.com/ckir/corelib/releases/download/v0.1.6/ckir-corelib-0.1.6.tgz"
  }
}
```

### 🦀 The Native Rust Binary
The `@ckir/corelib` package includes a `postinstall` script that automatically downloads the correct prebuilt Rust binary (`corelib-rust-*.node`) for your OS (Windows, Linux, or macOS) from the GitHub Release.

If the automatic download is blocked or fails, you can trigger it manually:
```bash
node node_modules/@ckir/corelib/scripts/postinstall.js
```

---

## 🛠️ Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (latest LTS)
- [pnpm](https://pnpm.io/) (for package management)
- [Rust](https://rust-lang.org/) (for native module builds)

### Installation & Build
```powershell
# Install all dependencies
pnpm install

# Build all packages using the Cockpit script
./DevelopersCockpit.ps1 -Build -All
```

### Running Tests
```powershell
# Run all tests across the monorepo
pnpm test-all
```

---

## 📖 Usage Examples

### 1. Core Utilities (@ckir/corelib)
The core package provides the foundation for logging, HTTP, and system info.

```typescript
import { logger, endPoint, getSysInfo, ConfigManager } from '@ckir/corelib';

// Structured Logging with Telemetry
logger.setTelemetry('on');
logger.info("Service initialized", { version: "0.1.0" });

// Resilient Fetch (ky wrapper)
const result = await endPoint('https://api.github.com/repos/google/gemini-cli');
if (result.status === 'success') {
  console.log(result.value.body);
}

// System Information (Cross-Runtime)
const stats = getSysInfo();
console.log(`OS: ${stats.os.platform}, Memory Used: ${stats.memory.heapUsed} bytes`);

// Configuration Management
const config = ConfigManager.getInstance();
await config.initialize();
const dbUrl = config.getValue('database.url');
```

### 2. Database Support (@ckir/corelib)
Unified API for SQLite and PostgreSQL with transaction support.

```typescript
import { createDatabase } from '@ckir/corelib';

const db = await createDatabase({ 
  dialect: 'sqlite', 
  url: 'file:./local.db' 
});

// Query execution
const users = await db.query('SELECT * FROM users WHERE active = ?', [true]);

// Transaction management
await db.transaction(async () => {
  await db.query('INSERT INTO logs (msg) VALUES (?)', ['Transaction started']);
  // ... more operations
  return { status: 'success', value: true };
});
```

### 3. Market Data (@ckir/corelib-markets)
Advanced financial utilities, including Nasdaq APIs and Yahoo Streaming.

```typescript
import { ApiNasdaqUnlimited, MarketStatus, YahooStreaming } from '@ckir/corelib-markets';

// 1. Nasdaq Resilient API
const nasdaqData = await ApiNasdaqUnlimited.endPoint('https://api.nasdaq.com/api/quote/AAPL/info');

// 2. Market Status & Scheduling
const status = await MarketStatus.getStatus();
if (status.status === 'success') {
  const sleepMs = MarketStatus.getSleepDuration(status.value);
  console.log(`Nasdaq is ${status.value.mrktStatus}. Sleeping ${sleepMs}ms until open.`);
}

// 3. Real-Time Yahoo Streaming (Rust-powered)
const stream = new YahooStreaming();
await stream.init({ silenceSeconds: 45 });
await stream.start();
stream.subscribe(["AAPL", "TSLA", "NVDA"]);

stream.on("pricing", (data) => console.log("Price Update:", data));
```

---

## 🔧 Development Workflow

### Tooling
- **Orchestration**: Use `DevelopersCockpit.ps1` for all build, test, and maintenance tasks.
- **Linting & Formatting**: [Biome](https://biomejs.dev/) is used for all TypeScript code. Run `pnpm lint-all`.
- **Testing**: [Vitest](https://vitest.dev/) for unit and integration tests.
- **Documentation**: [TypeDoc](https://typedoc.org/) for API documentation. Run `pnpm docs-all`.

### Engineering Standards
- **Surgical Edits**: Follow the `GEMINI.md` mandates for all changes.
- **FFI Stability**: Always verify the Rust bridge (`corelib-rust.node`) when changing core logic.
- **Type Safety**: Avoid `any`. Use `unknown` or specific interfaces. All public APIs must be documented.

---

## 📜 License

Refer to the [LICENSE](./LICENSE) file for details.
