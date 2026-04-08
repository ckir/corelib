# @ckir/corelib

The foundational package of the Corelib monorepo, providing essential utilities, resilient HTTP, structured logging, and database abstractions.

## Features

- **Multi-Runtime Support**: Compatible with Node.js, Bun, and Deno.
- **Resilient HTTP**: `RequestUnlimited` (based on `ky`) with automatic retries and consistent error serialization.
- **Structured Logging**: Strict Logger API with telemetry and structured data support.
- **Database Abstraction**: Unified interface for SQLite (via LibSQL) and PostgreSQL.
- **Configuration Management**: `ConfigManager` with support for CLI, Environment Variables, and Local/Remote encrypted files.
- **Native Core (FFI)**: High-performance logic implemented in Rust and exposed via N-API.
- **Runtime Utilities**: Platform-agnostic helpers for environment, file system, and telemetry.

## Installation

```bash
pnpm add @ckir/corelib
```

## Usage Examples

### 1. Resilient HTTP Requests
Use `endPoint` for single requests or `endPoints` for parallel requests.

```typescript
import { endPoint } from '@ckir/corelib';

const result = await endPoint('https://api.github.com/repos/ckir/corelib');

if (result.status === 'success') {
  // result.value is a SerializedResponse object
  console.log('Body:', result.value.body);
}
```

### 2. Proxied HTTP Requests (Rotation & Fallback)
`RequestProxied` provides an identical API to `RequestUnlimited` but adds automatic rotation, full fallback, and automatic removal of dead proxies.

```typescript
import { RequestProxied } from '@ckir/corelib';

const proxies = [
  "https://proxy-us.example.com",
  "https://proxy-eu.example.com",
  "https://proxy-as.example.com"
];

const client = new RequestProxied(proxies);

// Single request with automatic rotation and fallback
const result = await client.endPoint("https://api.nasdaq.com/api/market-info");

// Parallel requests with round-robin load balancing
const results = await client.endPoints([
  "https://api.nasdaq.com/api/quote/AAPL/info",
  "https://api.nasdaq.com/api/quote/TSLA/info"
]);
```

### 3. Structured Logging
The logger follows a strict `(msg: string, extras?: object)` signature and handles runtime differences automatically.

```typescript
import { logger } from '@ckir/corelib';

// Basic logging
logger.info("Application started");

// Logging with structured metadata
logger.error("Database connection failed", { 
  host: "localhost", 
  port: 5432,
  error: "Connection timeout" 
});

// Telemetry support (if configured)
logger.setTelemetry('on');
logger.info("Critical event", { telemetry: true });
```

### 4. Unified Database API
Switch between SQLite and PostgreSQL with minimal configuration changes.

```typescript
import { createDatabase } from '@ckir/corelib';

// SQLite
const db = await createDatabase({
  dialect: 'sqlite',
  url: 'file:./app.db'
});

// PostgreSQL
// const db = await createDatabase({
//   dialect: 'postgres',
//   url: 'postgres://user:pass@localhost:5432/dbname'
// });

// Querying (Returns a DatabaseResult discriminated union)
const result = await db.query('SELECT * FROM users WHERE active = ?', [true]);

if (result.status === 'success') {
  // result.value is a QueryResponse object containing .rows
  const users = result.value.rows;
  console.log(`Found ${users.length} users`);
} else {
  console.error('Query failed:', result.reason.message);
}

// Transactions
await db.transaction(async () => {
  await db.query('INSERT INTO logs (msg) VALUES (?)', ['Transaction step 1']);
  await db.query('UPDATE status SET value = ?', ['processed']);
  // Return success from the callback to commit the transaction
  return { status: 'success', value: true };
});
```


### 5. Configuration Management
Manage complex configuration hierarchies with ease.

```typescript
import { ConfigManager } from '@ckir/corelib';

const config = ConfigManager.getInstance();

// Initialize (parses CLI, Env, and local defaults)
await config.initialize();

// Get nested value with dot-notation
const dbPort = config.get('database.port');

// Load external encrypted configuration
await config.loadExternalConfig('https://remote-server.com/prod.json.enc');

// Reactive updates
config.on('change:database.port', (newPort) => {
  console.log(`Port changed to ${newPort}`);
});
```

### 6. Native Core FFI
Access high-performance Rust logic directly from TypeScript. The implementation is resilient and will disable FFI features if the native binary is missing rather than crashing the module.

```typescript
import { Core } from '@ckir/corelib';

// Check if FFI is available in current runtime
if (Core.isFfiAvailable()) {
  console.log('Rust Version:', Core.getVersion());
  const doubled = Core.logAndDouble("Double me", 21);
  console.log('Result:', doubled); // 42
}

// Safe run method that includes runtime info
Core.run("maintenance-task", { verbose: true });
```

### 7. Runtime Utilities
Platform-agnostic helpers for common tasks.

```typescript
import { detectRuntime, sleep, getEnv, getSysInfo } from '@ckir/corelib';

// Detect where we are (node, bun, deno, cloudflare, aws-lambda, etc.)
const runtime = detectRuntime();

// Resilient sleep
await sleep(1000);

// Platform-agnostic env access
const apiKey = getEnv('API_KEY');

// Detailed system and process telemetry (auto-redacts secrets)
const sysInfo = getSysInfo();
console.log('Memory Usage:', sysInfo.memory.rss);
```

