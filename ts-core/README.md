# @ckir/corelib

The foundational package of the Corelib monorepo, providing essential utilities, resilient HTTP, structured logging, and database abstractions.

## Features

- **Multi-Runtime Support**: Compatible with Node.js, Bun, and Deno.
- **Resilient HTTP**: `RequestUnlimited` (based on `ky`) with automatic retries and consistent error serialization.
- **Structured Logging**: Strict Logger API with telemetry and structured data support.
- **Database Abstraction**: Unified interface for SQLite (via LibSQL) and PostgreSQL.
- **Configuration Management**: `ConfigManager` with support for CLI, Environment Variables, and Local/Remote encrypted files.
- **Native Core (FFI)**: High-performance logic implemented in Rust and exposed via N-API.

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
  console.log('Status:', result.value.status);
} else {
  // result.reason contains the error details
  console.error('Request failed:', result.reason.message);
}
```

### 2. Structured Logging
The logger follows a strict `(msg: string, extras?: object)` signature.

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

### 3. Unified Database API
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

// Querying
const users = await db.query('SELECT * FROM users WHERE active = ?', [true]);

// Transactions
await db.transaction(async () => {
  await db.query('INSERT INTO logs (msg) VALUES (?)', ['Transaction step 1']);
  await db.query('UPDATE status SET value = ?', ['processed']);
  return { status: 'success', value: true };
});
```

### 4. Configuration Management
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

### 5. Native Core FFI
Access high-performance Rust logic directly from TypeScript.

```typescript
import { Core } from '@ckir/corelib';

// Check if FFI is available in current runtime
if (Core.isFfiAvailable()) {
  const result = Core.run("some-task", { param: 123 });
  console.log("FFI Result:", result);
}
```
