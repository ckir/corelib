# @ckir/corelib-markets

Market data and financial utilities for the Corelib monorepo.

## Features

- **Market Data**: Tools for retrieving and processing financial data.
- **Optional Dependency**: Built upon `@ckir/corelib`.

## Installation

```bash
pnpm add @ckir/corelib-markets
```

## Usage Example

```typescript
import { Markets } from '@ckir/corelib-markets';
```

## Nasdaq API Wrapper

High-resilience wrapper for Nasdaq APIs with custom headers and response verification.

```typescript
import { ApiNasdaqUnlimited } from '@ckir/corelib-markets';

// Single request
const result = await ApiNasdaqUnlimited.endPoint('https://api.nasdaq.com/api/some/endpoint');

if (result.status === 'success') {
  console.log('Data:', result.value);
} else {
  console.error('Error:', result.reason.message);
}

// Parallel requests
const results = await ApiNasdaqUnlimited.endPoints(['https://api.nasdaq.com/api/endpoint1', 'https://api.nasdaq.com/api/endpoint2']);
```
