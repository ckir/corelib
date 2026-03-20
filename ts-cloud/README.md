# ts-cloud: Multi-Edge TypeScript Proxy Service

A portable TypeScript service exposing identical HTTP endpoints across **Cloudflare Workers**, **AWS Lambda**, and **Google Cloud Run**. 

This project is part of the Corelib monorepo and is tightly coupled with `@ckir/corelib` and `@ckir/corelib-markets`, utilizing their core abstractions for database connectivity, resilient HTTP requests, and structured logging.

## Core Features

- **Shared Routing (Hono)**: A single, config-agnostic `Hono` application instance shared across all platforms.
- **Resilient Proxying**: Leverages `@ckir/corelib`'s `endPoint` utility for proxied requests with built-in retries and timeouts.
- **Nasdaq Market Data**: Specialized edge proxy for the Nasdaq API, enforcing required headers and providing high-resilience fetching via `@ckir/corelib-markets`.
- **Structured Edge Logging**: Implements a custom `StrictLogger` for edge environments that outputs structured JSON to `console.log`.
- **Platform Adapters**: Thin entry points for Cloudflare, AWS Lambda, and Cloud Run that handle environment extraction and context injection.

## Project Structure

```text
src/
├── core/
│   ├── router.ts      # Shared Hono application logic and routes
│   └── logger.ts      # Edge-optimized structured logger
├── retrieve/
│   └── RequestUnlimitedCloud.ts  # Generic HTTP proxy router
├── markets/
│   └── nasdaq/
│       └── ApiNasdaqUnlimitedCloud.ts # Nasdaq-specific proxy router
└── platform/
    ├── cloudflare/    # Cloudflare Worker entry point
    ├── aws/           # AWS Lambda (ESM) handler
    └── cloudrun/      # Google Cloud Run (Node.js) server
```

## API Endpoints

- **`GET /health`**: Returns system status and current platform.
- **`POST /api/v1/ky`**: Generic resilient HTTP proxy.
- **`POST /api/v1/markets/nasdaq`**: Nasdaq-specific resilient market data proxy.

## Usage Examples

### Health Check
```bash
curl https://your-service-url/health
```

### RequestUnlimited (Generic Edge Proxy)
Expose corelib's resilient fetching logic via the `/api/v1/ky` endpoint.

#### Single Request
```bash
curl -X POST https://your-service-url/api/v1/ky \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://api.github.com/zen"
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

### Nasdaq Market Data (ApiNasdaqUnlimitedCloud)
Specialized proxy for Nasdaq API calls. Enforces correct browser-like headers and provides automatic retries.

#### Single Quote Info
```bash
curl -X POST https://your-service-url/api/v1/markets/nasdaq \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks"
     }'
```

#### Bulk Nasdaq Requests
```bash
curl -X POST https://your-service-url/api/v1/markets/nasdaq \
     -H "Content-Type: application/json" \
     -d '{
       "endPoints": [
         { "url": "https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks" },
         { "url": "https://api.nasdaq.com/api/quote/MSFT/info?assetclass=stocks" }
       ]
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
  --args "dist/cloudrun/server.js"
```

## Configuration

The service expects the following environment variables (where applicable):
- `CORELIB_TURSO_URL`: The URL of your Turso database.
- `CORELIB_TURSO_TOKEN`: The authentication token for Turso.
- `PORT`: (Cloud Run only) The port the server should listen on (defaults to 3000).
