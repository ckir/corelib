# Contributing

The full engineering rules live in [AGENTS.md](AGENTS.md); this is the short version.

## Setup

- Node 24 (`.nvmrc`) and pnpm (version pinned in `package.json`). Use **pnpm only**, never npm or yarn.
- Rust via [rustup](https://rustup.rs). The toolchain is pinned in `rust-toolchain.toml` and installed on first use.
- Optional but used by CI: `cargo install cargo-deny --locked` and Docker.
- Run `./install-hooks.sh` once to install the git hooks (lefthook): pre-commit runs format, lint and the strict checks; pre-push runs `pnpm verify:full`.

## Before you open a PR

| Command | What it checks |
|---|---|
| `pnpm verify:fast` | format, strict lint, dependency rules, lint, typecheck |
| `pnpm verify:full` | build, browser-bundle check, tests |
| `pnpm test-all:coverage` | tests plus the coverage floors in each `vitest.config.ts` |
| `pnpm audit:prod` | production dependency advisories (high and above) |
| `cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings` | Rust lints |
| `cargo test --manifest-path rust/Cargo.toml -- --test-threads=1` | Rust tests |
| `cargo deny --manifest-path rust/Cargo.toml check` | Rust advisories, licenses, sources |

## Conventions

- Logging: `logger.child({ section })`, signature `(msg, extras?)`, structured data in `extras`. No `console.*` in source.
- No `any` in source (`noExplicitAny` and `noConsole` are errors; tests are exempt). Justify exceptions with an inline `biome-ignore`.
- External HTTP goes through `RequestUnlimited`. Layering is `ts-core` <- `ts-markets` <- `ts-cloud` (`pnpm deps:check`).
- Changing a payload type that crosses the FFI? The equality tests against `rust/index.d.ts` must still pass.
- Update the relevant README for any behaviour or API change. Bug fixes need a regression test.
- Commits follow conventional style: `fix(ts-core): ...`, `feat(ts-markets): ...`, `ci: ...`, one logical change each.

## Releasing

Releases are cut from `main` by pushing an annotated `vX.Y.Z` tag; `.github/workflows/pipeline.yml` does the rest.

1. Bump the version in lockstep: the four `package.json` files, `rust/Cargo.toml` and the `corelib-rust` entry in `rust/Cargo.lock`. Commit as `chore: release vX.Y.Z` and push `main`.
2. Push the tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z`.
3. The pipeline runs `check-version` (tag equals every manifest), `build-ts` and `build-rust` (3 tarballs, 5 native modules, 15 CLI binaries), `verify-assets` (all 23 present, tarball versions match), then `release` (GitHub Release) and `publish-npm`.
4. `publish-npm` waits for approval of the `npm-publish` environment. Approve it in the Actions UI; it skips versions already on npm, so a failed run can simply be re-run.

The same build runs without publishing on pull requests that touch `rust/`, the packages, `.github/` or the lockfiles, every Monday, and on manual dispatch (Actions -> Corelib Pipeline -> Run workflow). A red rehearsal means the next release would fail: fix it before tagging.
`NPM_TOKEN` must be an npm **Automation** (2FA-bypass) token with publish rights on `@ckirg`.
