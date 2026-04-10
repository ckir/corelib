# GEMINI Mandates: Corelib Monorepo

This document defines the foundational architectural rules and development standards for the Corelib project. These mandates take absolute precedence over general defaults.

## 1. Architectural Principles

- **Multi-Runtime First**: All code in `ts-core` must be isomorphic or provide runtime-specific implementations for **Node.js, Bun, and Deno**.
- **Monorepo Structure**: 
    - `ts-core`: Base logic, FFI, logging, and resilient HTTP.
    - `ts-cloud` / `ts-markets`: Extension packages that depend on `ts-core`.
    - `rust`: Private Rust core exposed via N-API (FFI).
- **Strict Logger API**: The logger must strictly follow the `(msg: string, extras?: object)` signature. Never revert to unstructured logging.
- **Resilient Retrieval**: Use `RequestUnlimited` (wrapper around `ky`) for all external HTTP calls to ensure automatic retries and consistent error serialization.
- **Transparent Proxy Pattern**: Edge proxy endpoints (in `ts-cloud`) must be transparent for single-URL requests, returning the target response body and status directly. Bulk requests should continue to return arrays of `RequestResult` objects.

## 2. Tooling & Workflow

- **Management**: Use `DevelopersCockpit.ps1` (Windows) or `DevelopersCockpit.py` (Cross-Runtime) as the primary interface for building, testing, and cleaning.
- **Package Manager**: Use `pnpm` exclusively. Never use `npm` or `yarn`.
- **Build System**: Use `tsup` for bundling ESM. All packages must be `"type": "module"`.
- **Documentation**: All public APIs must be documented. 
    - TS docs are generated via TypeDoc.
    - Rust docs are generated via `cargo doc` and moved to `rust/docs`.
    - Run `pnpm docs-all` to regenerate the entire unified documentation suite.
    - Live Docs: [ckir.github.io/corelib](https://ckir.github.io/corelib/index.html)

## 3. Engineering Standards

- **Linting & Formatting**: Biome is the source of truth. 
    - Run `pnpm lint-all` (which executes `biome check`) before any commit. This enforces both linting and formatting.
- **Testing**:
    - Use **Vitest** for all TypeScript tests and **MSW** for network mocks.
    - Maintain 100% pass rate for `pnpm test-all` across **Ubuntu, macOS, and Windows**.
- **Type Safety**: Avoid `any`. Export critical types from package entry points (`index.ts`).
- **FFI Stability**: The Rust FFI bridge is critical. Always verify the prebuilt `.node` binaries when changing core logic.

## 4. CI/CD Pipeline (`pipeline.yml`)

The monorepo uses a strictly staged GitHub Actions pipeline:
1.  **Validate**: Linting and formatting check (Biome).
2.  **Test**: Multi-OS execution (Ubuntu, macOS, Windows). **Mandatory**: TS packages must be built before testing to ensure correct workspace resolution.
3.  **Deploy Docs**: Triggered on `main` branch push. Publishes unified index to GitHub Pages.
4.  **Release**: Triggered on `v*` tags. Builds and attaches 11 assets:
    - TS Packages (`.tgz` for core, cloud, markets).
    - Rust FFI Nodes (Darwin x64/arm64, Linux x64, Win x64).
    - `yahoo_streamer` CLI Binaries (Darwin x64/arm64, Linux x64, Win x64).

## 5. Development Environment & Tools

The following tools are available in the development environment and should be used for relevant tasks:
- **Cloud & Serverless**: `wrangler` (Cloudflare), `sam` (AWS), `gcloud` (GCP).
- **Automation & Containers**: `act` (Local GitHub Actions), `docker` (Docker Desktop), `gh` (GitHub CLI).
- **Environment**: `wsl` (Ubuntu 24.04).
- **Security & Secrets**: `sops` (Mozilla SOPS).
- **CLI Utilities**: `fd` (Fast find), `sd` (Smart search/replace), `rip` (Safe rm).

## 6. Gemini Operational Mandates

- **Validation**: Every implementation task **must** conclude with `pnpm format-all`, `pnpm lint-all`, `pnpm test-all`, `pnpm build-all` and `pnpm docs-all`.
- **Surgical Edits**: Prefer `replace` over `write_file` for large files to preserve structure.
- **Usage Examples**: When adding new features, immediately update `README.md` with clear examples, specifically noting installation via release `.tgz` assets if applicable.
- **No Regressions**: If a change causes a TypeDoc warning or a Lint violation, it is incomplete. Fix it before reporting success.
