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

## Configuration

The `ConfigManager` handles loading and overriding configurations from defaults, files, env, and CLI.

### Usage Example

```typescript
import { ConfigManager } from '@ckir/corelib';

const manager = ConfigManager.getInstance();
await manager.initialize();
console.log(globalThis.sysconfig); // Access global config
console.log(manager.getConfig()); // Or directly

// Update value
manager.updateValue('key.path', 'newValue');

// Env override: CORELIB_KEY_PATH='value'
// CLI override: --key-path='value'
```
// ... existing content ...

### 6. Database (SQLite/Postgres)
Unified multi-runtime database support with transactions, prepared statements, and streaming.

```typescript
import { createDatabase } from '@ckir/corelib';

const db = await createDatabase({ dialect: 'sqlite', url: 'libsql://remote-or-file' });

// Query
const result = await db.query<{ name: string }>('SELECT name FROM users');
if (result.status === 'success') {
  console.log(result.value.rows);
}

// Transaction
await db.transaction(async () => {
  await db.query('INSERT INTO users (name) VALUES (?)', ['Alice']);
  return { status: 'success', value: true };
});

// Prepared
const prep = await db.driver.prepare('SELECT * FROM users WHERE id = ?');
const exec = await prep.value.execute([1]);
await prep.value.close();

// Stream
await db.driver.stream('SELECT * FROM large_table', [], (row) => console.log(row));
```
