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

## 2. Tooling & Workflow

- **Management**: Always use `DevelopersCockpit.ps1` as the primary interface for building, testing, and cleaning.
- **Package Manager**: Use `pnpm` exclusively. Never use `npm` or `yarn`.
- **Build System**: Use `tsup` for bundling ESM. All packages must be `"type": "module"`.
- **Documentation**: All public APIs must be documented via TypeDoc. Run `pnpm -r docs` after significant changes.
- Rust documentation is generated with `cargo doc` and automatically moved to `rust/docs`.
- Run `pnpm -r docs` (or option D in Developers Cockpit) to update both TS and Rust docs.

## 3. Engineering Standards

- **Linting & Formatting**: Biome is the source of truth. 
    - Run `pnpm -r lint` (which executes `biome check`) before any commit.
    - Use `biome-ignore` only when strictly necessary (e.g., `any` types for FFI or non-null assertions in tests).
- **Testing**:
    - Use **Vitest** for all TypeScript tests.
    - Use **MSW** (Mock Service Worker) for all network-related tests.
    - Maintain 100% pass rate for `pnpm -r test`.
- **Type Safety**:
    - Avoid `any` where possible. Prefer `unknown` or specific interfaces.
    - Export critical types (like `StrictLogger`, `RequestResult`) from package entry points (`index.ts`).
- **FFI Stability**: 
    - The Rust FFI bridge is a critical dependency. Always verify `logAndDouble` and `getVersion` stubs when changing core logic.
    - Use `as any` or `biome-ignore` for Deno-specific FFI calls if types are unstable.

## 4. Gemini Operational Mandates

- **Validation**: Every implementation task **must** conclude with `pnpm -r build`, `pnpm -r lint`, `pnpm -r test`, and `pnpm -r docs`.
- **Surgical Edits**: Prefer `replace` over `write_file` for large files to preserve existing comments and structure.
- **Usage Examples**: When adding new features, immediately update the corresponding `README.md` with clear usage examples.
- **No Regressions**: If a change causes a TypeDoc warning or a Lint violation, it is incomplete. Fix it before reporting success.
