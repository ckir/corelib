# GitHub Pages site — design

Date: 2026-10-23. Status: approved in principle by the owner (visual direction approved in-session; this document
fixes the build and deployment details, then was reviewed by Antigravity and by a fresh-context builder).
Area: repository web presence, CI deploy stage, docs.

## Intent and why

The GitHub Pages URL (`https://ckir.github.io/corelib/`) is the first thing a stranger sees, and today it is
broken: `.github/workflows/pipeline.yml:207-254` runs `pnpm docs-all` and then uploads the repository-root
`docs/` folder, but the generated trees land in `ts-core/docs`, `ts-markets/docs`, `ts-cloud/docs` (TypeDoc) and
`rust/docs` (rustdoc). The root folder contains no `index.html` — only `USER_GUIDE.html`, the PDF and two
ledgers — so the deployed root has nothing to serve.

The owner wants a modern front-facing site at `/` that answers two questions in one scroll — **what is in this
repo** and **how to use it** — with the generated API reference moving under `/api` and the existing user guide
under `/guide`. The visual direction was approved from a rendered mockup: deep-navy canvas, violet→blue
gradient as the single accent, isometric cube mark, glass code window with traffic lights, one graphic per
section, and a handwritten corner note.

## Goals

1. Root site at `/` explaining the four artefacts (`@ckirg/corelib`, `@ckirg/corelib-markets`,
   `@ckirg/corelib-cloud`, `corelib-rust`) and how to start using them.
2. Generated API reference served at `/api/core/`, `/api/markets/`, `/api/cloud/`, `/api/rust/`, with a
   generated `/api/` landing page in the same visual language.
3. The existing guide served at `/guide/` (HTML) with the PDF alongside it.
4. Deploy stays on GitHub Actions → Pages, triggered only by pushes to `main`, inside the existing
   `deploy-docs` job.
5. Local and CI assembly share one build script; a broken internal link fails the build.
6. Every API name, package name, command and claim on the page is true of this repository at build time.

## Non-goals

- No CMS, blog, search, version switcher, dark/light toggle or i18n in v1.
- No framework (Astro, VitePress, Next, Starlight). The site is hand-written HTML/CSS with a small progressive
  enhancement script; see "Why static" below.
- No change to TypeDoc configuration or the docs each package already generates; no change to `cargo doc`.
- No rewriting of `docs/USER_GUIDE.html`.
- No hosting change away from GitHub Pages; no custom domain, no analytics, no third-party embeds or webfonts.

## Anti-goals (a failure even if it technically works)

- A page that documents an API that does not exist, or that shows a snippet that would not compile against the
  published packages.
- A deploy that silently uploads an empty or partial directory (the current failure) — the build must fail
  loudly when an expected docs folder is missing.
- Blocking the deploy job on a new toolchain: no added build dependency, no new lockfile churn, no HTML-parser
  package.
- A site that is slower or less accessible than the TypeDoc it replaces: no render-blocking external assets,
  no layout shift from late-loading CSS, no hover-only affordances.

## Constraints

- `pnpm` only; Biome is the formatter/linter; Node 24 in CI (`.github/workflows/pipeline.yml`).
- The deploy job already runs `build-all` before `docs-all` (`pipeline.yml:238-242`); the site build runs after
  `docs-all` so it can copy the generated trees. The job currently does **not** install the pinned Rust
  toolchain, although `docs-all` calls `cargo doc` — see the CI change below.
- `docs-all` deletes and rewrites the per-package `docs` folders on every run, so no site source may live there.
- The committed `docs/USER_GUIDE.html` and `docs/USER_GUIDE.pdf` are consumed as-is; the site does not
  regenerate or rewrite them.
- Pages deployment is an Actions artifact upload (`actions/upload-pages-artifact`), so Jekyll processing is not
  involved; a `.nojekyll` marker ships anyway.
- Repository rules that apply: no `console.*` in application code (the browser asset is not application code),
  README updated for behaviour changes, tests for new code paths.

## Decisions (the owner's, as decided)

- Root becomes a new site; existing generated docs move under `/api` (owner: "current pages will go to /api").
- The site carries the approved hero treatment through the whole page: full-bleed gradient sections, glass
  cards, one graphic per section (owner: "carry this same treatment").
- Content answers "what is in this repo and how to use it" (owner).
- Design approved in session (owner: "I approve").

### Decisions made by the builder (stated here so they can be rejected)

- **Why static.** The repo already publishes a static tree through Pages; the page needs no data fetching, no
  routing beyond anchors and no content pipeline. A framework would add a second build system, a second lockfile
  surface and a slow CI step for ~30 KB of CSS and HTML. Hand-written HTML keeps the deploy job at one extra
  command and keeps the output inspectable.
- **Base path.** This is a Pages *project* site, so `/api` alone would resolve to `ckir.github.io/api`. Authored
  links are written `{{BASE}}/api/` and the build substitutes `{{BASE}}`. `SITE_BASE` is normalised to a leading
  slash and **no trailing slash**; an empty value means the domain root. Default `/corelib`; `SITE_BASE=` for
  local preview and future custom domains. The token is always followed by `/`, so `//` and protocol-relative
  URLs are impossible.
- **Routes.** `/` site, `/api/*` generated reference, `/guide/` guide. Directory routes carry a trailing slash in
  authored links to avoid a redirect hop.
- **Artifact directory.** `_site/` at the repository root, gitignored and wiped before every assembly. The
  committed `docs/` folder keeps holding the guide and ledgers; it is no longer the artifact root.
- **Version.** Rendered from the root `package.json` at build time (`{{VERSION}}`), also used to cache-bust
  `assets/site.css` and `assets/site.js` via `?v={{VERSION}}`. Nothing is hardcoded.
- **Runtime tabs** in the quickstart are functional (Node/Bun/Deno switch the install command) and degrade to
  the Node command with JavaScript disabled.
- **Link parsing without a dependency.** `check-site.mjs` extracts `href`/`src` values with targeted regular
  expressions over the authored pages. Generated docs are never parsed.

## The design

### Visual system

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#050a1c` | page canvas |
| `--text` / `--muted` | `#eef2ff` / `#93a0c7` | body / secondary copy |
| accent ramp | `#7c3aed → #4f46e5 → #2563eb` | logo, gradient words, buttons, glows |
| highlight | `#a855f7 → #3b82f6` | eyebrow diamonds, small icon fills |
| panel | `rgba(13,20,48,.55)` + `1px rgba(99,102,241,.18)` | glass cards, code windows |
| type | system UI stack; `ui-monospace` for code | no webfont download |

The cube is one SVG `<symbol>` reused via `<use>`; its three face gradients are defined once in a hidden `<defs>`.
Glows are CSS radial gradients, never images. Motion is limited to one slow dot travelling along the N-API bridge
line and is disabled under `prefers-reduced-motion`.

### Page structure (single scroll)

1. **Sticky nav** — cube + wordmark, anchor links, version pill, gradient CTA. Collapses to logo + CTA below 860px.
2. **Hero** — lockup, headline, lede, category strip, four icon features; right side the code window over
   gradient blobs with the handwritten note.
3. **What's in the box** — three package cards (real exports, install line, `/api` link).
4. **Native core** — Rust↔N-API↔JS diagram with ticker tape, plus three numbered notes.
5. **Feature rows** — retry timeline, trace log stream, edge topology, alternating left/right.
6. **Quickstart** — install → request → stream, runtime tabs, three runtime cards.
7. **API call-to-action** — gradient panel linking to `/api`, `/guide/`, the guide PDF and GitHub.
8. **Footer** — package/docs/project columns, licence, "Built with pnpm, tsup and Rust".
9. **404 page** — same canvas, `{{BASE}}` links back to `/` and `/api/`.

### Content rules

- Only names that exist in the packages today: `endPoint`, `endPoints`, `RequestProxied`, `ConfigManager`,
  `logger.child`, `AlpacaStreaming`, `YahooStreaming`, `FinnhubStreaming`, `Historical`, `NasdaqPolling`,
  `MarketMonitor`, `createRouter`, `kyRouter`, `nasdaqRouter`, `sqlRouter`.
- Snippets are short and correct: `endPoint` returns `RequestResult<T>` (a `status: "success" | "error"` union),
  streaming events are `pricing`, `market`, `log`, `error`.
- Claims the repository does not support are omitted; no invented benchmarks, no invented user counts.
- The mockup's build note (`corelib/docs → deployed to /api`) does not ship.

### Build and deployment

Three small modules, no new dependencies:

- `scripts/site-routes.mjs` — single source of truth: the base-path normaliser, the generated route table
  (`/api/`, `/api/core/`, `/api/markets/`, `/api/cloud/`, `/api/rust/`, `/guide/`), the authored page list, the
  external-link allowlist and the resolver used by the checker. Pure functions, unit-tested.
- `scripts/build-site.mjs` — wipes `_site/`, copies `site/` → `_site/` (substituting `{{BASE}}` and
  `{{VERSION}}`), copies each TypeDoc tree to `_site/api/<pkg>/`, copies `rust/docs` to `_site/api/rust/` and
  writes `_site/api/rust/index.html` as a redirect to the single crate directory rustdoc generated (found by
  scanning, not hardcoded), copies the guide to `_site/guide/index.html` with `USER_GUIDE.pdf` beside it, writes
  the generated `_site/api/index.html`, writes `.nojekyll`, then runs the link check. Missing source trees fail
  with a named error instead of publishing a partial site.
- `scripts/check-site.mjs` — resolves every internal `href`/`src` on the **authored** pages (built `index.html`,
  `404.html`, the generated `api/index.html`, and the redirect stub) against the route table and the output tree;
  rejects unknown routes, `href="#"`, missing assets and same-document fragments with no matching `id`.
  Cross-document fragments are out of scope. Generated TypeDoc and rustdoc trees are verified structurally only
  (each copied tree has an entry `index.html`), never crawled, so third-party links inside generated docs cannot
  block a deploy. `--source` mode checks `site/` against the route table without requiring a docs build.

Pipeline change in `deploy-docs` (`.github/workflows/pipeline.yml:220-254`):

```yaml
      - name: Install pinned Rust toolchain     # cargo doc runs in docs-all
        uses: ./.github/actions/setup-rust
      ...
      - name: Generate documentation
        run: pnpm docs-all
      - name: Build static site
        run: pnpm site:build
      - name: Upload documentation artifact
        uses: actions/upload-pages-artifact@v5
        with:
          path: _site
```

CI `validate` (`.github/workflows/pipeline.yml:78-93`) gains, after the dependency-rules step:

```yaml
      - name: Site link check
        run: pnpm site:check
      - name: Site unit tests
        run: pnpm test:site
```

Root scripts: `site:build` (assembly + link check), `site:check` (link check only, `--source` when `_site/` is
absent), `site:preview` (build, then serve `_site/` at `http://localhost:4173` with `SITE_BASE=`),
`test:site` (Vitest unit tests). `site:check` joins the lefthook pre-commit command alongside `format-lint`, the
CI `validate` job, and the `verify:fast` script so all three entry points agree.

### Local preview

`scripts/serve-site.mjs` is a dependency-free Node static server (correct content types, `index.html` for
directory routes, 404 fallback) so preview does not depend on Python or a global package. `site:preview` runs
`site:build` with `SITE_BASE=` and then the server.

### Accessibility and performance targets

- Semantic landmarks (`header`, `nav`, `main`, `section` with headings, `footer`), one `h1`, skip link.
- All decorative SVG `aria-hidden`; meaningful icons carry text labels; focus-visible ring on every link and tab.
- Contrast ≥ 4.5:1 for body copy, ≥ 3:1 for large text on the darkest panel.
- No external requests at runtime; total transferred weight under 100 KB uncompressed excluding the guide.
- Tabs are buttons with `aria-selected` and keyboard support; content is present without JavaScript.

## Testing and verification

- `pnpm test:site` — Vitest unit tests for `scripts/site-routes.mjs` (base normalisation including `""`, `/` and
  `/corelib`, route resolution, asset resolution, anchor extraction, external allowlist). A root
  `vitest.config.ts` covers `tests/site/` only; package suites keep their own configs. Runs in CI `validate`.
- `pnpm site:check` — link/route/asset validation on authored pages; wired into lefthook pre-commit, CI
  `validate`, and `verify:fast`.
- `pnpm site:build` — end-to-end assembly against freshly generated docs; run in the deploy job and manually with
  `pnpm docs-all && pnpm site:build`. Fails on a missing docs tree instead of publishing an empty site.
- Manual pass on the built output at 1440, 1024 and 390 px widths, plus a keyboard-only pass over nav, tabs and
  CTAs.
- Post-deploy: request `/`, `/api/`, `/api/core/`, `/api/rust/`, `/guide/` and a missing path (404) and confirm
  the expected response.

## Documentation updates

- `README.md` — replace the "Live Docs" pointer with the three routes and note the site is built from `site/`.
- `AGENTS.md` §2 — the hardcoded live-docs URL at line 29 becomes the site root, with `/api` and `/guide` named.
- `AGENTS.md` §4 — the deploy stage uploads `_site`, not `docs`.
- `ARCHITECTURE.md` §8.3 — the docs step now says TypeDoc + rustdoc → assembled `_site` → Pages.
- `.gitignore` — add `/_site` and `/.superpowers/`.

## Open questions

None. Deferred: OG image, custom domain, docs search, docs version switcher.
