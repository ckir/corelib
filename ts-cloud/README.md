# ts-cloud: Multi-Edge TypeScript Proxy Service

A portable TypeScript service exposing identical HTTP endpoints across **Cloudflare Workers**, **AWS Lambda**, and **Google Cloud Run**.

> [!IMPORTANT]
> Not on the public npm registry — install from GitHub Releases. See the [root install guide](../README.md#-installation-for-external-projects).

This project is part of the Corelib monorepo and is tightly coupled with `@ckirg/corelib` and `@ckirg/corelib-markets`, utilizing their core abstractions for database connectivity, resilient HTTP requests, and structured logging.

## Core Features

- **Shared Routing (Hono)**: A single, config-agnostic `Hono` application instance shared across all platforms.
- **Resilient Proxying**: Leverages `@ckirg/corelib`'s `endPoint` utility for proxied requests with built-in retries and timeouts.
- **Nasdaq Market Data**: Specialized edge proxy for the Nasdaq API, enforcing required headers and providing high-resilience fetching via `@ckirg/corelib-markets`.
- **SQL on the Edge**: Executes parameterized SQLite/Turso queries directly from the edge via the central SQL endpoint.
- **Structured Edge Logging**: Implements a custom `StrictLogger` for edge environments that outputs structured JSON to `console.log`.
- **Platform Adapters**: Thin entry points for Cloudflare, AWS Lambda, and Cloud Run that handle environment extraction and context injection.

## Project Structure

```text
src/
├── core/
│   ├── router.ts      # Shared Hono application logic and routes
│   └── logger.ts      # Edge-optimized structured logger
├── database/
│   └── SqlCloud.ts    # SQL query router (Turso)
├── retrieve/
│   └── RequestUnlimitedCloud.ts  # Generic HTTP proxy router
├── markets/
│   └── nasdaq/
│       ├── ApiNasdaqUnlimitedCloud.ts # Nasdaq-specific proxy router
│       └── MarketStatusCloud.ts       # Nasdaq Market Status proxy router
└── platform/
    ├── cloudflare/    # Cloudflare Worker entry point
    ├── aws/           # AWS Lambda (ESM) handler
    └── cloudrun/      # Google Cloud Run (Node.js) server
```

## Using the package

`@ckirg/corelib-cloud` is both a library and a set of deployable bundles:

```ts
import { Cloud, createRouter } from "@ckirg/corelib-cloud"; // Hono routers + factory (ESM, typed)
```

The platform bundles are exposed as subpaths (`@ckirg/corelib-cloud/aws`, `/cloudflare`, `/cloudrun`, plus `/dist/*`). Installing the package needs `@jsr:registry=https://npm.jsr.io` in your `.npmrc` (its `@ckirg/corelib-markets` dependency pulls `@gadicc/yahoo-finance2` from JSR).

## API Endpoints

### Core Endpoints
- **`GET /health`**: Returns system status and current platform.
- **`GET /api/v1/health`**: Versioned health check.

### Data & Proxy Endpoints
- **`POST /api/v1/ky`**: Generic resilient HTTP proxy (supports single or bulk parallel requests).
- **`GET /api/v1/ky`**: Transparent single-URL proxy via `?url=` query parameter. Returns target response body and status directly. Used by `RequestProxied`.
- **`POST /api/v1/markets/nasdaq`**: Nasdaq-specific resilient market data proxy.
- **`GET /api/v1/markets/nasdaq`**: Transparent single-URL Nasdaq proxy via `?url=` query parameter. Enforces Nasdaq headers and returns target response body and status directly. Used by `RequestProxied`.
- **`POST /api/v1/markets/nasdaq/historical`**: Yahoo Finance historical data proxy.
- **`GET /api/v1/markets/nasdaq/status`**: Fetches current Nasdaq market status (Open/Closed/Pre/After).
- **`GET /api/v1/markets/nasdaq/groups/top100`**: Retrieves the list of current Nasdaq 100 constituent symbols.
- **`POST /api/v1/sql`**: Executes a parameterized SQL query on Turso/LibSQL.

## Authentication & Security

Every `/api/v1` route except `/api/v1/health` (and `/health`) requires a bearer token:

```bash
curl -H "Authorization: Bearer $CORELIB_API_TOKEN" https://your-service-url/api/v1/markets/nasdaq/status
```

- Set `CORELIB_API_TOKEN` as a binding/secret on every platform (`wrangler secret put CORELIB_API_TOKEN`, the `ApiToken` parameter in `sam-corelib/template.yaml`, or an env var on Cloud Run).
- **Fail-closed:** if no token is configured the service answers `503` to protected routes; a missing or wrong token answers `401`.
- The examples below omit the `Authorization` header for brevity; add it to each call.
- **Proxy targets are restricted.** `/api/v1/ky` only fetches `http(s)` URLs without credentials, and refuses loopback, private, link-local (cloud metadata) and `.local`/`.internal` hosts with `400`. `/api/v1/markets/nasdaq` only fetches `nasdaq.com` hosts.
- Known limits: the guard checks the URL text only. A public hostname that resolves to a private address, and redirects to one, are not detected on the edge, so keep the token secret.
- AWS: CORS on the Function URL is limited to the `AllowedOrigin` parameter.

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

#### Transparent GET Proxy (used by RequestProxied)
```bash
curl "https://your-service-url/api/v1/ky?url=https://api.github.com/zen"
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

#### Transparent GET Proxy (used by RequestProxied)
```bash
curl "https://your-service-url/api/v1/markets/nasdaq?url=https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks"
```

#### Market Status
```bash
curl https://your-service-url/api/v1/markets/nasdaq/status
```

#### Nasdaq 100 Symbols
```bash
curl https://your-service-url/api/v1/markets/nasdaq/groups/top100
```

#### Historical Data Proxy
```bash
curl -X POST https://your-service-url/api/v1/markets/nasdaq/historical \
     -H "Content-Type: application/json" \
     -d '{
       "symbol": "AAPL",
       "options": { "period1": "2023-01-01", "interval": "1d" }
     }'
```

### SQL Query (Turso)
Execute SQL queries directly via the edge service.

```bash
curl -X POST https://your-service-url/api/v1/sql \
     -H "Content-Type: application/json" \
     -d '{
       "sql": "SELECT * FROM users WHERE active = ?",
       "params": [true]
     }'
```

## Configuration Boilerplate

### Cloudflare Workers (`wrangler.toml`)

The project ships with a `wrangler.toml`. Below is its current structure — adjust `name`, `main`, and the commented `[vars]` block to suit your account. The `[alias]` stubs are **required** to keep Node-only server deps (pino, postgres, @libsql/client) out of the Cloudflare bundle:

```toml
name = "ts-cloud"
main = "src/platform/cloudflare/worker.ts"
compatibility_date = "2025-02-04"
compatibility_flags = ["nodejs_compat"]

# Stubs for Node-only deps that must not execute on the edge.
# Keep these — removing them breaks the Cloudflare bundle.
[alias]
"pino"                                = "./src/platform/cloudflare/server-dep-stub.mjs"
"pino-pretty"                         = "./src/platform/cloudflare/server-dep-stub.mjs"
"pino-lambda"                         = "./src/platform/cloudflare/server-dep-stub.mjs"
"pino-socket"                         = "./src/platform/cloudflare/server-dep-stub.mjs"
"@google-cloud/pino-logging-gcp-config" = "./src/platform/cloudflare/server-dep-stub.mjs"
"postgres"                            = "./src/platform/cloudflare/server-dep-stub.mjs"
"@libsql/client"                      = "./src/platform/cloudflare/server-dep-stub.mjs"

[dev]
port = 3000

[vars]
PLATFORM = "cloudflare"
# CORELIB_TURSO_URL   = ""   # set via wrangler secret put CORELIB_TURSO_URL
# CORELIB_TURSO_TOKEN = ""   # set via wrangler secret put CORELIB_TURSO_TOKEN
```

### AWS Lambda

The SAM template is `sam-corelib/template.yaml` (function `corelib`, `nodejs24.x`, handler `handler.handler`). Build the deployment package with `scripts/package-lambda.sh`; see [Deployment](#aws-lambda-1).

Set these as Lambda environment variables (the template wires them from stack parameters):

- `CORELIB_API_TOKEN` (**required**): bearer token for every `/api/v1` request. Left unset, `/api/v1/*` answers 503 (fail closed); `/health` stays open.
- `CORELIB_TURSO_URL`, `CORELIB_TURSO_TOKEN`: only for `/api/v1/sql`.

### Google Cloud Run

No `cloudrun` deploy config is included — deploy directly from source:

```bash
gcloud run deploy ts-cloud \
  --source . \
  --command "node" \
  --args "dist/cloudrun/server.js" \
  --set-env-vars "CORELIB_TURSO_URL=libsql://your-db.turso.io,CORELIB_TURSO_TOKEN=your-token"
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
Run from `ts-cloud/`; wrangler is a dev dependency and reads `wrangler.toml`:
```bash
pnpm exec wrangler login                     # once; or export CLOUDFLARE_API_TOKEN
pnpm exec wrangler secret put CORELIB_API_TOKEN
pnpm exec wrangler deploy
```
Without the `CORELIB_API_TOKEN` secret, `/api/v1/*` answers 503. Roll back with `pnpm exec wrangler rollback`.

### AWS Lambda
The package is more than `handler.js`: it is `handler.mjs`, its chunk files and the native module `corelib-rust.node`. Build it with the script, not by hand:

```bash
scripts/package-lambda.sh        # from the repo root; needs docker, pnpm, zip
aws lambda update-function-code --function-name corelib \
  --zip-file fileb://ts-cloud/dist/function.zip
```

**Why a script:** Lambda's runtime (Amazon Linux 2023) has glibc 2.34, while a `corelib-rust.node` built on a current Linux host, or the `corelib-rust-linux-x64.node` release asset (built on `ubuntu-latest`), needs glibc 2.38 and cannot be loaded there. `loadFFI()` catches the failure and disables the Rust features, so the function still deploys and `/health` still answers 200. The script builds the module inside `amazonlinux:2023` with the toolchain pinned in `rust-toolchain.toml`, fails if the binary needs glibc newer than 2.34, and loads it in the `public.ecr.aws/lambda/nodejs:24` image (native module plus `GET /health`) before it writes `ts-cloud/dist/function.zip`.

`update-function-code` leaves the function's configuration alone, so the stack in `sam-corelib/` drifts until the next `sam deploy`; pass the same `ApiToken` then or the deployed token is overwritten. Keep the previous package (`aws lambda get-function --query Code.Location`) if you may need to roll back.

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
