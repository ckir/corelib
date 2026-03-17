# Corelib Monorepo

A high-performance, resilient, and multi-runtime monorepo for TypeScript and Rust. This workspace provides foundational utilities, cloud extensions, and financial market tooling designed for **Node.js, Bun, and Deno**.

## 🚀 Overview

This repository is structured as a pnpm monorepo, integrating TypeScript's flexibility with Rust's performance through FFI (Foreign Function Interface). It is built on principles of resilience, performance, and cross-runtime compatibility.

### Key Features
- **Isomorphic Core**: All foundational utilities in `ts-core` support Node.js, Bun, and Deno.
- **Resilient HTTP**: Standardized fetch wrapper (`RequestUnlimited`) with automatic retries and consistent error serialization.
- **Strict Logging**: Structured logging API with `(msg: string, extras?: object)` signature and telemetry support.
- **Native Performance**: Performance-critical paths implemented in Rust via N-API/FFI.
- **Unified Configuration**: Centralized `ConfigManager` supporting overrides via files, environment variables, and CLI.

---

## 📂 Project Structure & Packages

| Package | Description | Documentation |
| :--- | :--- | :--- |
| **[`@ckir/corelib`](./ts-core/README.md)** | Core logic, FFI bridge, resilient HTTP, and database abstractions. | [README](./ts-core/README.md) |
| **[`@ckir/corelib-markets`](./ts-markets/README.md)** | Market data tooling (Nasdaq, Yahoo) and financial indicators. | [README](./ts-markets/README.md) |
| **[`@ckir/corelib-cloud`](./ts-cloud/README.md)** | Cloud-specific extensions for AWS, GCP, and Cloudflare. | [README](./ts-cloud/README.md) |
| **[`corelib-rust`](./rust/README.md)** | Native Rust core exposed via N-API (FFI). | [README](./rust/README.md) |

---

## 📦 Installation for External Projects

Since these packages are not published to the public NPM registry, you can install them directly from the GitHub Release assets.

### 1. Install via Direct URL (Recommended)
You can point your package manager directly to the `.tgz` file in the GitHub Release. Replace `v0.1.13` with the desired version.

```bash
# Using pnpm
pnpm add https://github.com/ckir/corelib/releases/download/v0.1.13/ckir-corelib-0.1.13.tgz
pnpm add https://github.com/ckir/corelib/releases/download/v0.1.13/ckir-corelib-markets-0.1.13.tgz

# Using npm
npm install https://github.com/ckir/corelib/releases/download/v0.1.13/ckir-corelib-0.1.13.tgz
```

### ⚠️ Important: Handling Internal Dependencies
Because `@ckir/corelib-markets` depends on `@ckir/corelib`, and neither is on NPM, your package manager might try to find `@ckir/corelib` on the public registry and fail (404). 

To fix this, add an **override** to your `package.json` so the manager knows to use the specific version for the sub-dependency:

**For pnpm (`package.json`):**
```json
"pnpm": {
  "overrides": {
    "@ckir/corelib": "https://github.com/ckir/corelib/releases/download/v0.1.13/ckir-corelib-0.1.13.tgz"
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
- [Node.js](https://nodejs.org/) (v24+ recommended)
- [pnpm](https://pnpm.io/) (v10+ required)
- [Rust](https://rust-lang.org/) (for native module builds)

### Common Commands
All workspace-wide commands are managed through `pnpm`:

| Command | Description |
| :--- | :--- |
| `pnpm install` | Install all dependencies and link packages |
| `pnpm build-all` | Build all packages in correct order |
| `pnpm test-all` | Run all unit and integration tests |
| `pnpm lint-all` | Run Biome linting and formatting checks |
| `pnpm format-all` | Apply Biome formatting automatically |
| `pnpm docs-all` | Regenerate all API documentation |
| `pnpm clean-all` | Wipe all `node_modules`, `dist`, and `target` folders |

---

## 📖 Usage Examples

### 1. Core Utilities (`@ckir/corelib`)
```typescript
import { logger, endPoint, ConfigManager } from '@ckir/corelib';

logger.info("Service initialized", { version: "0.1.13" });

const result = await endPoint('https://api.nasdaq.com/api/market-info');
if (result.status === 'success') {
  console.log(result.value.body);
}

const config = ConfigManager.getInstance();
await config.initialize();
const port = config.get('server.port');
```

### 2. Market Data (`@ckir/corelib-markets`)
```typescript
import { MarketMonitor, MarketSymbols, type MarketPhase } from '@ckir/corelib-markets';

// 1. Resilient Status Poller
const monitor = new MarketMonitor();
monitor.on("status-change", (phase: MarketPhase) => {
  console.log(`Market phase changed to ${phase}`);
});
monitor.start();

// 2. Persistent Symbol Database
const symbols = new MarketSymbols();
const aapl = await symbols.get("AAPL"); // Auto-refreshes if needed
```

---

## 📖 API Documentation

Detailed API documentation is generated for each package and published via GitHub Pages:

- **[Unified Documentation Index](https://ckir.github.io/corelib/index.html)**
- **[Core Utilities Documentation](https://ckir.github.io/corelib/ts-core/index.html)** (`@ckir/corelib`)
- **[Market Data Documentation](https://ckir.github.io/corelib/ts-markets/index.html)** (`@ckir/corelib-markets`)
- **[Cloud Extensions Documentation](https://ckir.github.io/corelib/ts-cloud/index.html)** (`@ckir/corelib-cloud`)
- **[Rust Native Core Documentation](https://ckir.github.io/corelib/rust/corelib_rust/index.html)** (`corelib-rust`)

---

## 📜 License

Refer to the [LICENSE](./LICENSE) file for details.
