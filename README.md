# @ckir/corelib

Multi-runtime TypeScript library with private Rust FFI (napi-rs).

Run `.\DevelopersCockpit.ps1` (Windows) or `pwsh DevelopersCockpit.ps1` (Linux/Mac) to open the Developers Cockpit.

## Developers Cockpit Menu
- P: Check Prerequisites & Health
- C: Clean project & Reinstall Prerequisites (Fresh Start)
- W: Watch TypeScript
- B: Build TypeScript
- L: Lint TypeScript Code
- T: Run Typescript Tests
- R: Build Rust
- U: Run Rust Tests
- F: Format Code
- V: Bump version
- D: Generate Documentation (TypeDoc)
- E: Create release package
- Q: Quit

## Linking for Development
For local linking (e.g., to corelib_live):
- In corelib/ts-core: `pnpm link --global`
- In corelib_live: `pnpm add @ckir/corelib --global`
- Repeat for @ckir/corelib-cloud and @ckir/corelib-markets.
- Changes: Run 'B' (build) or 'W' (watch) in Cockpit for immediate updates (links to dist).

## Installing from GitHub
- Core: `pnpm add @ckir/corelib@git+https://github.com/user/corelib.git#path:/ts-core`
- Cloud: `pnpm add @ckir/corelib-cloud@git+https://github.com/user/corelib.git#path:/ts-cloud`
- Markets: `pnpm add @ckir/corelib-markets@git+https://github.com/user/corelib.git#path:/ts-markets`
- Branch example: `#dev&path:/ts-core`
