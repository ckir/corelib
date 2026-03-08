# @ckir/corelib

The core package of the Corelib monorepo. Providing high-performance, resilient, and multi-runtime TypeScript utilities.

## Features

- **Multi-Runtime Support**: Node.js, Bun, Deno, and Edge environments.
- **Strict Logger**: A Pino-based logger with strict signatures and live system telemetry.
- **Resilient HTTP**: A robust `ky` wrapper for single or parallel requests with automatic retries (429, 5xx).
- **Rust FFI**: High-performance core logic implemented in Rust via N-API.
- **System Telemetry**: Synchronous cross-runtime system information provider.

## Installation

```bash
pnpm add @ckir/corelib
```

## Usage Example

```typescript
import { logger, endPoint, getSysInfo } from '@ckir/corelib';

// 1. Log with telemetry
logger.setTelemetry('on');
logger.info("Core initialized", { version: "0.1.0" });

// 2. Resilient fetch
const result = await endPoint('https://api.github.com/repos/user/repo');
if (result.status === 'success') {
  console.log(result.value.body);
}

// 3. System Stats
const stats = getSysInfo();
console.log(`Memory Used: ${stats.memory.heapUsed} bytes`);
```

## API Modules

- `Core`: Rust FFI (logAndDouble, getVersion)
- `logger`: Strict Logger (trace, debug, info, warn, error, fatal)
- `Retrieve`: HTTP Utilities (endPoint, endPoints)
- `Utils`: System Utilities (SysInfo, getSysInfo)
- `Configs`: Configuration Management
- `Database`: Dynamic Runtime Database Drivers
- `Common`: Shared utilities like `detectRuntime`
