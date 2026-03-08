# @ckir/corelib Monorepo

Multi-runtime TypeScript library with high-resilience utilities, logging, and private Rust FFI (napi-rs).

## Workspace Packages

- **[@ckir/corelib](./ts-core)**: Core library including FFI, logging, resilient HTTP requests, and system utilities.
- **[@ckir/corelib-cloud](./ts-cloud)**: Cloud-specific extensions and utilities.
- **[@ckir/corelib-markets](./ts-markets)**: Market data and financial utilities.

## Developers Cockpit

Run `.\DevelopersCockpit.ps1` (Windows) or `pwsh DevelopersCockpit.ps1` (Linux/Mac) to open the interactive management menu.

### Menu Options
- **P**: Check Prerequisites & Health
- **C**: Clean & Fresh Start
- **W / B**: Watch or Build TypeScript
- **L / F**: Lint or Format Code
- **T / U**: Run TS or Rust Tests
- **R**: Build Rust FFI
- **D**: Generate TypeDoc Documentation
- **V**: Bump Version
- **E**: Create Release Package
- **Q**: Quit

---

## Quick Start & Usage Examples

### 1. Resilient HTTP (Retrieve)
High-resilience HTTP client using `ky` with automatic retries (429, 5xx) and serialized results.

```typescript
import { RequestUnlimited, endPoint, endPoints } from '@ckir/corelib';

// Single Request
const result = await endPoint<{ id: number }>('https://api.example.com/user/1');

if (result.status === 'success') {
  console.log('User ID:', result.value.body.id);
  console.log('Status Code:', result.value.status);
} else {
  console.error('Request failed:', result.reason);
}

// Parallel Requests (maintained order)
const results = await endPoints(['/api/v1', '/api/v2']);
```

### 2. Strict Logger with Telemetry
High-performance logger (based on Pino) with strict signatures and optional system telemetry.

```typescript
import { logger } from '@ckir/corelib';

// Strict signature: (message: string, extras?: object)
logger.info("Application started", { port: 3000, env: "production" });

// Child loggers with independent settings
const authLogger = logger.child({ module: "auth" });

// Enable Telemetry (adds CPU, Memory, OS info to EVERY log call)
authLogger.setTelemetry("on");
authLogger.debug("User login attempt"); // Includes live system stats

// Change level dynamically
logger.level = 'debug';
```

### 3. System Information (Utils)
Cross-runtime (Node, Bun, Deno) system telemetry provider.

```typescript
import { SysInfo, getSysInfo } from '@ckir/corelib';

const info = getSysInfo();
console.log(`Runtime: ${info.runtime}`);
console.log(`Memory RSS: ${info.memory.rss} bytes`);
console.log(`OS: ${info.os} ${info.osVersion}`);
```

### 4. Rust FFI (Core)
High-performance logic powered by Rust via N-API.

```typescript
import { logAndDouble, getVersion } from '@ckir/corelib';

const version = getVersion();
const result = logAndDouble("Input value", 21); // Logs in Rust, returns 42
```

### 5. Runtime Detection (Common)
Unified runtime detection for isomorphic code.

```typescript
import { detectRuntime } from '@ckir/corelib';

const runtime = detectRuntime(); // 'node' | 'bun' | 'deno' | 'edge-cloudflare' ...
```

---

## Linking for Development
For local linking:
- In `corelib/ts-core`: `pnpm link --global`
- In your project: `pnpm add @ckir/corelib --global`

## Installing from GitHub
```bash
pnpm add @ckir/corelib@git+https://github.com/user/corelib.git#path:/ts-core
```
