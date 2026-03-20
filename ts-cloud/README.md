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

## Usage Examples

### Health Check
```bash
curl https://your-service-url/health
```

### RequestUnlimited (Edge Proxy)
Expose corelib's resilient fetching logic via the `/api/v1/ky` endpoint. This endpoint mirrors status codes and serializes errors.

#### Single Request
```bash
curl -X POST https://your-service-url/api/v1/ky \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://api.external.com/data",
       "options": {
         "method": "POST",
         "json": { "key": "value" }
       }
     }'
```

#### Bulk Parallel Requests
```bash
curl -X POST https://your-service-url/api/v1/ky \
     -H "Content-Type: application/json" \
     -d '{
       "endPoints": [
         { "url": "https://api.a.com/status" },
         { "url": "https://api.b.com/data", "options": { "timeout": 2000 } }
       ]
     }'
```

### SQL Query (Turso)
Execute a parameterized query against Turso:
```bash
curl -X POST https://your-service-url/api/v1/sql \
     -H "Content-Type: application/json" \
     -d '{
       "sql": "SELECT * FROM users WHERE id = ?",
       "params": [123]
     }'
```

## Development & Build

### Prerequisites
Ensure the Corelib monorepo dependencies are installed:
```bash
pnpm install
```

### Local Development (Cloudflare)
Run the service locally using Wrangler and Vitest:
```bash
# Start local dev server
pnpm run dev

# Run worker-specific tests
pnpm run test:worker
```

### Building Platform Bundles
Build all three platform-specific bundles into the `dist/` directory:
```bash
pnpm run build
```

This generates:
- `dist/cloudflare/worker.js`: Optimized ESM bundle for Cloudflare Workers.
- `dist/aws/handler.js`: ESM bundle for AWS Lambda (Node 24+).
- `dist/cloudrun/server.js`: ESM bundle for Google Cloud Run (Node 24+).

## Deployment

### Cloudflare Workers
```bash
pnpm exec wrangler deploy src/platform/cloudflare/worker.ts
```

### AWS Lambda
1. Build the bundle: `pnpm run build`
2. Zip the output: `cd dist/aws && zip -r function.zip handler.js`
3. Update Lambda code: `aws lambda update-function-code --function-name YOUR_FUNC --zip-file fileb://function.zip`

### Google Cloud Run
Deploy from the generated bundle:
```bash
gcloud run deploy ts-cloud \
  --source . \
  --command "node" \
  --args "dist/cloudrun/server.js" \
  --set-env-vars "TURSO_URL=...,TURSO_TOKEN=..."
```

## Configuration

The service expects the following environment variables:
- `TURSO_URL`: The URL of your Turso database.
- `TURSO_TOKEN`: The authentication token for Turso.
- `PORT`: (Cloud Run only) The port the server should listen on (defaults to 3000).
