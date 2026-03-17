# @ckir/corelib-cloud

Cloud-specific extensions and utilities for the Corelib monorepo, providing seamless integration with AWS Lambda, Google Cloud Run, and Cloudflare Workers.

## Features

- **Cloud Infrastructure**: Specialized helpers for serverless environments.
- **Platform-Agnostic Core**: Designed to work across AWS, GCP, and Cloudflare.
- **Optional Dependency**: Built on top of the robust `@ckir/corelib` core.

## Installation

```bash
pnpm add @ckir/corelib-cloud
```

## Usage Example

### 1. Cloud-Specific Middleware
Inject logic and environment handling directly into your serverless handlers.

```typescript
import { Cloud } from '@ckir/corelib-cloud';
import { logger } from '@ckir/corelib';

/**
 * Example for AWS Lambda with structured context.
 */
export const handler = async (event: any) => {
  logger.info("Lambda event received", { requestId: event.requestContext.requestId });

  // Cloud-specific logic here
  const result = await Cloud.someHelper(event);
  
  return {
    statusCode: 200,
    body: JSON.stringify(result),
  };
};
```

*(Note: The `Cloud` module is currently under active development. More specialized helpers for specific cloud providers are added regularly.)*
