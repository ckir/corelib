# ts-cloud: Multi-Edge TypeScript Proxy Service

A portable TypeScript service exposing identical HTTP endpoints across **Cloudflare Workers**, **AWS Lambda**, and **Google Cloud Run**. 

This project is part of the Corelib monorepo and is tightly coupled with `@ckir/corelib`, utilizing its core abstractions for database connectivity, resilient HTTP requests, and structured logging.

## Core Features

- **Shared Routing (Hono)**: A single, config-agnostic `Hono` application instance shared across all platforms.
- **Turso / SQLite Integration**: Uses `@ckir/corelib`'s `createDatabase` in `stateless` mode for edge-compatible database operations.
- **Resilient Proxying**: Leverages `@ckir/corelib`'s `endPoint` utility for proxied requests with built-in retries and timeouts.
- **Structured Edge Logging**: Implements a custom `StrictLogger` for edge environments that outputs structured JSON to `console.log`.
- **Platform Adapters**: Thin entry points for Cloudflare, AWS Lambda, and Cloud Run that handle environment extraction and context injection.

## Project Structure

```text
src/
├── core/
│   ├── router.ts      # Shared Hono application logic and routes
│   └── logger.ts      # Edge-optimized structured logger
└── platform/
    ├── cloudflare/    # Cloudflare Worker entry point
    ├── aws/           # AWS Lambda (ESM) handler
    └── cloudrun/      # Google Cloud Run (Node.js) server
```

## API Endpoints

- **`GET /health`**: Returns system status and current platform.
- **`ALL /proxy/*`**: Forwards the request to the specified URL using resilient fetching.
- **`POST /sql/query`**: Executes a parameterized SQL query against a Turso/SQLite database.
  - Body: `{ "sql": "SELECT...", "params": [...] }`

## Development & Build

### Prerequisites
Ensure the Corelib monorepo dependencies are installed:
```bash
pnpm install
```

### Building Platform Bundles
Build all three platform-specific bundles into the `dist/` directory:
```bash
pnpm run build
```

This will generate:
- `dist/cloudflare/worker.js`: Optimized ESM bundle for Cloudflare Workers.
- `dist/aws/handler.js`: ESM bundle for AWS Lambda (Node 24+).
- `dist/cloudrun/server.js`: ESM bundle for Google Cloud Run (Node 24+).

### Linting
```bash
pnpm run lint
```

## Configuration

The service expects the following environment variables (configured via platform-specific secrets/env):
- `TURSO_URL`: The URL of your Turso database.
- `TURSO_TOKEN`: The authentication token for Turso.
- `PORT`: (Cloud Run only) The port the server should listen on (defaults to 3000).
