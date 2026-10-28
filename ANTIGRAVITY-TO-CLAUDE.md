# Antigravity → Claude: review record

Findings are grouped by severity and tied to the artefact they concern. Entries are appended newest-last.

## 2026-10-23 — GitHub Pages site: divergent spec review

Transport: headless `agy -p --mode plan` (claudavity bridge unavailable in the session). Review mode, no files
modified by the reviewer; findings transcribed from stdout unedited in substance. Subject:
`docs/superpowers/specs/2026-10-23-github-pages-site-design.md`.

### 🔴 Blocker

1. **Rust doc destination has no entry point.** `cargo doc --no-deps` writes
   `rust/target/doc/corelib_rust/index.html`; `rust/package.json:20` copies `target/doc` to `rust/docs`, which
   has no root `index.html`. Copying that tree to `_site/api/rust/` would fail the structural check and serve a
   404 at `/api/rust/`. Fix: generate a redirect `index.html` in `_site/api/rust/`, or flatten.
2. **`SITE_BASE` slash contract undefined.** Mixing `{{BASE}}api/` and `{{BASE}}/api/` produces `/corelib//api/`
   or, with `SITE_BASE=/`, a protocol-relative `//api/`. Fix: normalise the base and standardise authored links.
3. **`--source` link check cannot resolve generated routes.** In `site/`, links target `/api/` and `/guide/`,
   which do not exist on disk before a build. Fix: resolve against the route table, not the filesystem.

### 🟡 Should-fix

4. **HTML parsing toolchain.** Node 24 has no DOM parser; the spec forbids new dependencies. State that the
   checker uses regular expressions.
5. **`_site/` idempotency.** The spec does not require wiping the output directory, leaving stale assets.
6. **Guide wrapper semantics.** Unclear whether `/guide/index.html` is a raw copy or gets a nav banner injected.
7. **CI `validate` steps.** The spec mentions `site:check`/`test:site` joining validate but does not give the
   YAML.
8. **No `404.html`.** A missed route falls through to GitHub's generic page instead of the site's canvas.
9. **Local preview.** Root-absolute paths do not resolve over `file://`; a preview story is needed.

### 🟢 Nit

10. Cache-bust the assets with a version query string (Pages caches for 600 s).
11. Enforce trailing slashes on directory routes to avoid redirect hops.
12. State that cross-document fragment checking is out of scope.

### Assumptions about the repo that were not true at the time

1. `_site/` was **not** in `.gitignore` (`.gitignore:1-53`).
2. `rust/typedoc.json` does not exist; Rust docs come from `cargo doc` (`rust/package.json:20`).
3. `deploy-docs` does **not** install the pinned Rust toolchain, yet runs `docs-all` → `cargo doc`
   (contrast `pipeline.yml:73` and `:127`).
4. The docs-update list omitted `AGENTS.md:29` (live docs URL) and `ARCHITECTURE.md:117`.
5. If `site:check` only lands in `lefthook.yml`, `pnpm verify:fast` still bypasses it.

### Alternatives offered (build/deploy only)

- **A. Relative links instead of `{{BASE}}`.** Zero substitution and preview anywhere; sub-pages must compute
  depth, and a custom 404 needs an absolute base anyway.
- **B. One build script + Vitest HTTP link test** against `_site/`. Real status codes, no bespoke parser; slower
  for pre-commit.
- **C. TypeDoc straight into `_site/api/`.** Skips a large copy; conflicts with the no-TypeDoc-change constraint.

### Single highest-conviction suggestion

Fix the Rust docs entry point contract: generate the redirect at `_site/api/rust/index.html` or the landing
links 404.

### Disposition

- Accepted: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 and repo corrections 1-5. The spec now specifies the base
  normaliser (`SITE_BASE` without a trailing slash, links authored `{{BASE}}/path`), a generated redirect for
  rustdoc detected by scanning, route-table-based `--source` checking, regex extraction, a wiped `_site/`
  assembly, an unmodified guide with a separate PDF link, the exact CI steps, a styled `404.html`, a
  dependency-free preview server, asset cache-busting, trailing slashes, the expanded docs list, and `site:check`
  in all three gates. `deploy-docs` gains the pinned Rust setup step.
- Rejected: Alternative A (relative links) because the 404 page needs a deterministic base; B (HTTP-based
  checking) as heavier for a pre-commit gate; C (TypeDoc direct output) because it conflicts with the
  no-TypeDoc-change constraint.

## 2026-10-28 — Full repository code review & quality audit

Mode: Whole-repo five-axis quality gate & architecture review (Correctness, Readability, Architecture, Security, Performance).
Trigger: User review and fix request.

### 🔴 Blocker / Critical

1. **Unpatched high-severity production dependency advisories (`pnpm audit:prod`).**
   - **Location:** `pnpm-workspace.yaml:24` / `package.json:11`
   - **Problem:** `pnpm audit:prod` failed with 2 High-severity CVEs:
     - `zod` < 4.6.6 (GHSA-mrhx-c7xc-m3w5: Memory exhaustion on constrained collections)
     - `body-parser` >= 2.0.0 < 2.4.0 (GHSA-27r3-jxmh-p828: DoS via trailing bytes after compressed body)
     Both were pulled transitively via `ts-markets` -> `@jsr/gadicc__yahoo-finance2` -> `@modelcontextprotocol/sdk`.
   - **Fix Applied:** Added `"zod": ">=4.6.6"` and `"body-parser": "^2.4.0"` to `overrides` in `pnpm-workspace.yaml`. `pnpm audit:prod` now passes with 0 high/critical vulnerabilities.

### 🟡 Should-fix

2. **Transparent Proxy in `ts-cloud` drops non-JSON content types and headers.**
   - **Location:** `ts-cloud/src/retrieve/RequestUnlimitedCloud.ts:88` and `ts-cloud/src/markets/nasdaq/ApiNasdaqUnlimitedCloud.ts:96`
   - **Problem:** Single URL proxy endpoints unconditionally returned `c.json(...)`, stringifying non-JSON formats (HTML, CSV, SVG) and dropping upstream caching/ETag headers.
   - **Fix Applied:** Inspected `content-type` header. For non-JSON text bodies, return `c.text(...)`; for JSON, return `c.json(...)`. Forward safe caching headers (`etag`, `cache-control`, `last-modified`). Covered with unit test in `RequestUnlimitedCloud.test.ts`.

3. **Missing `pnpm audit:prod` gate in CI pipeline.**
   - **Location:** `.github/workflows/pipeline.yml:106`
   - **Problem:** `pnpm-workspace.yaml:23` states that patched overrides are "Gated by `pnpm audit:prod` in CI", but `pipeline.yml` omitted this step from the `validate` job.
   - **Fix Applied:** Added `Production dependency audit` step (`run: pnpm audit:prod`) to the `validate` job in `pipeline.yml`.

4. **Streaming client cleanup did not stop health tracking.**
   - **Location:** `ts-markets/src/nasdaq/datafeeds/streaming/yahoo/YahooStreaming.ts:156`, `alpaca/AlpacaStreaming.ts:179`, and `finnhub/FinnhubStreaming.ts:113`
   - **Problem:** Calling `.clean()` released `keepAlive` and cleaned native storage, but left `this.health` in the active tracking state.
   - **Fix Applied:** Added `this.health.stop()` inside `clean()` across all three streaming facades.

### 🟢 Nit & Structural Improvements (Generative)

5. **SSRF redirect bypass vector on open redirects:** Consider `{ redirect: "manual" }` or validating redirect location headers via `checkProxyTarget`.
6. **Rust `corelib-streaming` crate extraction:** Decouple native streaming engine from N-API bindings to accelerate builds and enable headless CLI streamer binaries.
7. **Streaming download support in `RequestUnlimited`:** Introduce stream-response helper to eliminate buffering large historical archives in memory on edge workers.
