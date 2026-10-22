# GitHub Pages Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a hand-written static landing site at `/`, the generated API reference at `/api/`, and the user guide at `/guide/` on GitHub Pages.

**Architecture:** One authored page tree (`site/`) plus three dependency-free Node scripts: a route/ref resolver, a link checker, and an assembler that merges the site with the docs `pnpm docs-all` produces into `_site/`. The existing `deploy-docs` job uploads `_site/` instead of the repository-root `docs/`.

**Tech Stack:** Node 24 ESM scripts, Vitest 4 for the resolver tests, hand-written HTML/CSS plus one progressive-enhancement script, GitHub Actions Pages deploy.

**Spec:** `docs/superpowers/specs/2026-10-23-github-pages-site-design.md`

## Global Constraints

- No new dependencies. No HTML-parser package; the checker uses regular expressions.
- `pnpm` only. Node 24 in CI. Files stay ESM (`.mjs`) and `"type": "module"`-compatible.
- Every authored internal link is written `{{BASE}}/path` (leading slash after the token). `SITE_BASE` defaults to `/corelib`, is normalised to no trailing slash, and `""` means the domain root. Directory routes keep a trailing slash.
- `{{VERSION}}` comes from the root `package.json`; nothing on the page hardcodes a version.
- No `console.*` in application code. The browser asset is exempt but still logs nothing.
- Biome is the formatter: tabs, double quotes, semicolons, `--write --unsafe` via `pnpm lint-all`.
- Commit style is conventional commits (`feat:`, `fix:`, `docs:`, `chore:`), one commit per task.
- All content claims must be true of this repo: no invented APIs, benchmarks or counts.

## Review Focus

- A protocol-relative link (`//api/`) must fail the check, not resolve to `https://api/`.
- `SITE_BASE` given as `""`, `"/"`, `"/corelib/"` or `"corelib"` must all produce clean paths — never `//`.
- `cargo doc` emitting zero or several crate directories must fail the build with a named error.
- `site:build` run before `docs-all` must fail loudly, never publish a site with dead `/api` links.
- A nav link to a renamed section id must fail the check.
- With JavaScript disabled, the quickstart must still show the Node install command.

---

### Task 1: Route and reference resolver

**Files:**
- Create: `scripts/site-routes.mjs`
- Create: `vitest.config.ts`
- Create: `tests/site/site-routes.test.mjs`
- Modify: `package.json` (root scripts)
- Modify: `.gitignore`

**Interfaces:**
- Produces: `normaliseBase(raw) -> string`, `routeForFile(relPath) -> string`, `extractRefs(html) -> {attr: "href"|"src", value: string}[]`, `extractIds(html) -> Set<string>`, `resolveTarget(ref, pageRoute, base) -> {type:"external"} | {type:"protocol-relative"} | {type:"same-document", hash} | {type:"internal", path, hash}`, `checkPages({pages, knownRoutes, knownFiles, base}) -> string[]`, and the constants `DEFAULT_BASE`, `AUTHORED_PAGES`, `GENERATED_ROUTES`, `GENERATED_FILES`, `ASSET_FILES`.

- [ ] **Step 1: Add the ignore entries**

Add to `.gitignore` under the existing docs block (after line 48):

```
/_site
/.superpowers/
```

- [ ] **Step 2: Create the root Vitest config**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/site/**/*.test.mjs"],
	},
});
```

Add to root `package.json` scripts: `"test:site": "vitest run --config vitest.config.ts"`.

- [ ] **Step 3: Write the failing tests**

`tests/site/site-routes.test.mjs` — cover the table, resolution and error paths:

```js
import { describe, expect, it } from "vitest";
import {
	checkPages,
	extractIds,
	extractRefs,
	normaliseBase,
	resolveTarget,
	routeForFile,
} from "../../scripts/site-routes.mjs";

describe("normaliseBase", () => {
	it.each([
		["", ""],
		["/", ""],
		["/corelib", "/corelib"],
		["/corelib/", "/corelib"],
		["corelib", "/corelib"],
		["//corelib//", "/corelib"],
	])("normalises %j to %j", (input, expected) => {
		expect(normaliseBase(input)).toBe(expected);
	});

	it("rejects an absolute URL", () => {
		expect(() => normaliseBase("https://ckir.github.io/corelib")).toThrow(
			/base must be a path/,
		);
	});
});

describe("resolveTarget", () => {
	it("resolves a token link under the project base", () => {
		expect(resolveTarget("{{BASE}}/api/", "/", "/corelib")).toEqual({
			type: "internal",
			path: "/api/",
			hash: "",
		});
	});

	it("resolves a token link at the domain root", () => {
		expect(resolveTarget("{{BASE}}/api/", "/", "")).toEqual({
			type: "internal",
			path: "/api/",
			hash: "",
		});
	});

	it("resolves a relative link from a page", () => {
		expect(resolveTarget("api/", "/", "/corelib")).toEqual({
			type: "internal",
			path: "/api/",
			hash: "",
		});
	});

	it("resolves a parent-relative link between routes", () => {
		expect(resolveTarget("../guide/", "/api/", "/corelib")).toEqual({
			type: "internal",
			path: "/guide/",
			hash: "",
		});
	});

	it("keeps the same-document hash separate", () => {
		expect(resolveTarget("#packages", "/", "/corelib")).toEqual({
			type: "same-document",
			hash: "packages",
		});
	});

	it("flags protocol-relative URLs", () => {
		expect(resolveTarget("//api/", "/", "/corelib")).toEqual({
			type: "protocol-relative",
		});
	});

	it("treats absolute URLs as external", () => {
		expect(resolveTarget("https://github.com/ckir/corelib", "/", "/corelib")).toEqual(
			{ type: "external" },
		);
	});

	it("strips the cache-busting query", () => {
		expect(resolveTarget("{{BASE}}/assets/site.css?v=0.4.0", "/", "/corelib")).toEqual(
			{ type: "internal", path: "/assets/site.css", hash: "" },
		);
	});
});

describe("extractRefs / extractIds", () => {
	it("finds href and src values", () => {
		expect(extractRefs('<a href="a/">x</a><img src="b.png">')).toEqual([
			{ attr: "href", value: "a/" },
			{ attr: "src", value: "b.png" },
		]);
	});

	it("finds ids", () => {
		expect([...extractIds('<h2 id="packages">x</h2><div id="start">')]).toEqual([
			"packages",
			"start",
		]);
	});
});

describe("checkPages", () => {
	const known = {
		knownRoutes: new Set(["/", "/api/", "/guide/"]),
		knownFiles: new Set(["/assets/site.css"]),
		base: "/corelib",
	};

	it("accepts a clean page", () => {
		const pages = [
			{
				route: "/",
				html: '<h1 id="top">x</h1><a href="{{BASE}}/api/">API</a><a href="#top">top</a><link href="{{BASE}}/assets/site.css?v=1">',
			},
		];
		expect(checkPages({ pages, ...known })).toEqual([]);
	});

	it("rejects an unknown route", () => {
		const errors = checkPages({
			pages: [{ route: "/", html: '<a href="{{BASE}}/nope/">x</a>' }],
			...known,
		});
		expect(errors[0]).toMatch(/unknown route: \/nope\//);
	});

	it("rejects a missing asset", () => {
		const errors = checkPages({
			pages: [{ route: "/", html: '<link href="{{BASE}}/assets/missing.css">' }],
			...known,
		});
		expect(errors[0]).toMatch(/unknown asset: \/assets\/missing.css/);
	});

	it("rejects an empty fragment", () => {
		const errors = checkPages({ pages: [{ route: "/", html: '<a href="#">x</a>' }], ...known });
		expect(errors[0]).toMatch(/empty fragment/);
	});

	it("rejects a fragment with no matching id", () => {
		const errors = checkPages({
			pages: [{ route: "/", html: '<a href="#missing">x</a>' }],
			...known,
		});
		expect(errors[0]).toMatch(/missing anchor: #missing/);
	});
});

describe("routeForFile", () => {
	it.each([
		["index.html", "/"],
		["404.html", "/404.html"],
		["api/index.html", "/api/"],
	])("maps %s to %s", (file, route) => {
		expect(routeForFile(file)).toBe(route);
	});
});
```

- [ ] **Step 4: Run the tests to confirm they fail**

Run: `pnpm test:site`
Expected: FAIL — `Failed to resolve import "../../scripts/site-routes.mjs"`.

- [ ] **Step 5: Implement `scripts/site-routes.mjs`**

Header comment naming the purpose and the two callers (`build-site.mjs`, `check-site.mjs`). Implement:
`normaliseBase` (throw `new Error("base must be a path, got ...")` when the value contains `://` or `?`/`#`; collapse `//`; trim trailing `/`); `routeForFile`; `extractRefs` (regex `/\b(href|src)\s*=\s*"([^"]*)"/g`); `extractIds` (`/\bid\s*=\s*"([^"]+)"/g`); `resolveTarget` (replace `{{BASE}}`, classify, split `#`, drop `?`, resolve relative against the page route, strip the normalised base prefix); `checkPages` (per page: protocol-relative → `protocol-relative URL`; same-document with empty hash → `empty fragment`; same-document missing id → `missing anchor: #id`; internal ending `/` not in `knownRoutes` → `unknown route: path`; internal file not in `knownFiles` → `unknown asset: path`). Export the constants exactly as listed in Interfaces.

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `pnpm test:site`
Expected: PASS, all cases green.

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json vitest.config.ts scripts/site-routes.mjs tests/site/site-routes.test.mjs
git commit -m "feat(site): add route table and reference resolver"
```

---

### Task 2: Link checker CLI

**Files:**
- Create: `scripts/check-site.mjs`
- Modify: `package.json` (root script `site:check`)

**Interfaces:**
- Consumes: everything Task 1 exports.
- Produces: CLI `node scripts/check-site.mjs [--source] [--root _site]`, exit 0 clean / exit 1 with one line per error / exit 2 when `_site/` is missing and `--source` was not passed.

- [ ] **Step 1: Write the CLI**

`--source` reads `site/index.html` and `site/404.html`, maps them with `routeForFile`, and checks against `GENERATED_ROUTES ∪ GENERATED_FILES ∪ ASSET_FILES ∪ ["/", "/404.html"]`, with `base = normaliseBase(process.env.SITE_BASE ?? DEFAULT_BASE)`.

Build mode reads `_site/index.html`, `_site/404.html`, `_site/api/index.html`, `_site/api/rust/index.html`; `knownRoutes` is `GENERATED_ROUTES ∪ ["/", "/404.html"]`, `knownFiles` is every file the build wrote under `assets/` and `guide/` plus `GENERATED_FILES`. Build mode takes the base from `_site/.site-base` (written by Task 5) so the check always matches the substitution that was actually applied; if that file is absent, exit 2 with `_site/.site-base not found`.

Print `site: N pages checked, no problems` on success so CI logs show it ran.

Add root script: `"site:check": "node scripts/check-site.mjs"` and `"site:check:source": "node scripts/check-site.mjs --source"`.

- [ ] **Step 2: Verify the failure path before the pages exist**

Run: `pnpm site:check:source`
Expected: exit 2 with `site/index.html not found` (the pages arrive in Task 3).

- [ ] **Step 3: Commit**

```bash
git add scripts/check-site.mjs package.json
git commit -m "feat(site): add authored-page link checker"
```

---

### Task 3: The page itself

**Files:**
- Create: `site/index.html`
- Create: `site/404.html`
- Create: `site/assets/site.css`
- Create: `site/assets/favicon.svg`

**Interfaces:**
- Consumes: the `{{BASE}}` and `{{VERSION}}` tokens, and the routes in `site-routes.mjs`.
- Produces: `#packages`, `#native`, `#start` section ids; the class contract `site.js` uses in Task 4 — `[data-runtime-tab]` buttons, `[data-runtime-panel]` panels, `[data-copy]` buttons with a `data-copy-target` id, `[data-nav-toggle]`, `[data-nav-links]`.

- [ ] **Step 1: Port the approved visual system**

Use the approved mockup as the visual reference: `.superpowers/brainstorm/65821-1792706940/content/full-page.html`. Move its `<style>` block into `site/assets/site.css` unchanged except for the additions below, and rewrite the markup into `site/index.html` with:
- token links: `{{BASE}}/api/`, `{{BASE}}/guide/`, `{{BASE}}/guide/USER_GUIDE.pdf`, `{{BASE}}/assets/site.css?v={{VERSION}}`, `{{BASE}}/assets/favicon.svg`;
- a skip link as the first focusable element, `main` landmark, one `h1`;
- the nine sections from the spec: nav, hero, packages, native core, three feature rows, quickstart, API CTA, footer;
- `aria-hidden="true"` on every decorative SVG;
- a `@media (prefers-reduced-motion: reduce)` block that disables the bridge animation, and a `:focus-visible` ring used by every link, button and tab;
- the runtime strip replaced by three `[data-runtime-tab]` buttons inside the quickstart step-1 card, with the Node command in the default `[data-runtime-panel]` and Bun/Deno panels marked `hidden`;
- a `404.html` with the same canvas, the cube, `{{BASE}}/` and `{{BASE}}/api/` links.

- [ ] **Step 2: Write `site/assets/favicon.svg`**

The same isometric cube as the page mark, no external references, `viewBox="0 0 200 200"`.

- [ ] **Step 3: Check the pages**

Run: `pnpm site:check:source`
Expected: `site: 2 pages checked, no problems`.

- [ ] **Step 4: Verify weight and no external requests**

Run: `wc -c site/index.html site/assets/site.css site/404.html` and `rg -o 'https?://[^"]+' site/index.html | sort -u`
Expected: total under 100 KB; the only absolute URLs are the GitHub, npm and releases links.

- [ ] **Step 5: Check the content truthfully**

Open `ts-core/src/index.ts`, `ts-markets/src/index.ts`, `ts-cloud/src/index.ts` and confirm every exported name used on the page exists. Remove any claim you cannot point at a line of source for.

- [ ] **Step 6: Commit**

```bash
git add site
git commit -m "feat(site): add landing page, 404 and visual system"
```

---

### Task 4: Progressive enhancement

**Files:**
- Create: `site/assets/site.js`
- Modify: `site/index.html` (add the deferred script tag before `</body>`)

**Interfaces:**
- Consumes: the data attributes listed in Task 3.
- Produces: behaviour only; no globals, no console output, no network calls.

- [ ] **Step 1: Implement the three behaviours**

Runtime tabs: click and `ArrowLeft`/`ArrowRight` switch `aria-selected`, toggle `hidden` on the matching panel, keep focus on the pressed button. Copy buttons: `navigator.clipboard.writeText` on the target's `textContent`, swap the button label to `Copied` for 1.5 s, restore it, and leave the label unchanged when the clipboard API is unavailable. Nav toggle: `aria-expanded` plus `hidden` on `[data-nav-links]` under 860 px. All three must be no-ops when their elements are absent. Add `<script src="{{BASE}}/assets/site.js?v={{VERSION}}" defer></script>` before `</body>` in `site/index.html`.

- [ ] **Step 2: Verify syntax and the no-JS fallback**

Run: `node --check site/assets/site.js`
Expected: exit 0.
Then run `pnpm site:check:source` and confirm the script `src` resolves.

- [ ] **Step 3: Commit**

```bash
git add site/assets/site.js site/index.html
git commit -m "feat(site): add tabs, copy buttons and mobile nav"
```

---

### Task 5: Assembly and preview

**Files:**
- Create: `scripts/build-site.mjs`
- Create: `scripts/serve-site.mjs`
- Create: `tests/site/build-site.test.mjs`
- Modify: `package.json` (root scripts `site:build`, `site:preview`)

**Interfaces:**
- Consumes: `normaliseBase`, `GENERATED_ROUTES`, `ASSET_FILES`, `routeForFile` from Task 1; the checker from Task 2.
- Produces: `substitute(html, {base, version}) -> string`, `renderApiIndex({base, version, packages}) -> string`, `detectCrateDir(rustDocsDir) -> string`, and the CLI `node scripts/build-site.mjs`. `renderApiIndex` renders the API landing page in the site's visual language: the same stylesheet, a back link to `{{BASE}}/`, and one card per package linking `core/`, `markets/`, `cloud/`, `rust/` with the installed version.

- [ ] **Step 1: Write the failing tests**

`tests/site/build-site.test.mjs`: `substitute` replaces both tokens and leaves other text alone; `detectCrateDir` returns the single directory containing `index.html` in a `mkdtemp` fixture, throws `/exactly one crate directory/` for zero and for two; `renderApiIndex` contains one link per package (`core/`, `markets/`, `cloud/`, `rust/`) and the supplied version string.

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm test:site`
Expected: FAIL — cannot resolve `../../scripts/build-site.mjs`.

- [ ] **Step 3: Implement the builder**

Order of operations: `rmSync(_site, {recursive:true, force:true})`; copy `site/` → `_site/` substituting tokens in `.html`; copy `ts-core/docs` → `_site/api/core/`, `ts-markets/docs` → `_site/api/markets/`, `ts-cloud/docs` → `_site/api/cloud/`; `detectCrateDir("rust/docs")` then copy to `_site/api/rust/` and write `_site/api/rust/index.html` as a `<meta http-equiv="refresh" content="0; url=<crate>/index.html">` page with a real link fallback; copy `docs/USER_GUIDE.html` → `_site/guide/index.html` and `docs/USER_GUIDE.pdf` → `_site/guide/USER_GUIDE.pdf` **unmodified**; write `_site/api/index.html` from `renderApiIndex`; write `_site/.nojekyll`; write the normalised base into `_site/.site-base` (empty file for the domain root). Each source path is checked first and throws `new Error("missing <path>: run pnpm docs-all first")`. Finish by invoking the Task 2 checker in build mode.

`serve-site.mjs`: port `process.env.PORT ?? 4173`, serves `_site`, directory → `index.html`, miss → `404.html` with status 404, correct `Content-Type` for `.html`, `.css`, `.js`, `.svg`, `.pdf`.

Root scripts (use the root `cross-env` devDependency so Windows works): `"site:build": "node scripts/build-site.mjs"`, `"site:preview": "cross-env SITE_BASE= pnpm site:build && cross-env SITE_BASE= node scripts/serve-site.mjs"`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:site`
Expected: PASS.

- [ ] **Step 5: Build the real thing**

Run: `pnpm build-all && pnpm docs-all && pnpm site:build`
Expected: `site: 4 pages checked, no problems` and a `_site/` containing `index.html`, `404.html`, `api/{core,markets,cloud,rust}/index.html`, `guide/index.html`, `guide/USER_GUIDE.pdf`, `.nojekyll`, `.site-base`.
Then `pnpm site:preview`, open `http://localhost:4173` at 1440, 1024 and 390 px, click all three runtime tabs, tab through the page with the keyboard, and load `http://localhost:4173/nope` for the 404.

- [ ] **Step 6: Fail-path check**

Temporarily move `rust/docs` aside, run `pnpm site:build`, confirm it exits non-zero naming `rust/docs`, and restore it.

- [ ] **Step 7: Commit**

```bash
git add scripts/build-site.mjs scripts/serve-site.mjs tests/site/build-site.test.mjs package.json
git commit -m "feat(site): assemble docs and site into _site"
```

---

### Task 6: Gates and deployment

**Files:**
- Modify: `.github/workflows/pipeline.yml` (validate job ~line 93, deploy-docs job ~line 220)
- Modify: `lefthook.yml`
- Modify: `package.json` (`verify:fast`)

**Interfaces:**
- Consumes: `site:check`, `test:site`, `site:build` from Tasks 1-5.

- [ ] **Step 1: Wire the local gates**

`lefthook.yml` pre-commit gains a second command after `format-lint`:

```yaml
    site-check:
      run: pnpm site:check:source
```

Append `&& pnpm site:check:source` to the `verify:fast` script in root `package.json`.

- [ ] **Step 2: Wire CI**

In `validate`, after the dependency-rules step:

```yaml
      - name: Site link check
        run: pnpm site:check:source

      - name: Site unit tests
        run: pnpm test:site
```

In `deploy-docs`, add the pinned toolchain before `Build all packages`:

```yaml
      - name: Install pinned Rust toolchain
        uses: ./.github/actions/setup-rust
```

and after `Generate documentation`:

```yaml
      - name: Build static site
        run: pnpm site:build
```

Change the artifact path from `docs` to `_site`.

- [ ] **Step 3: Verify the workflow parses and the gates run**

Run: `pnpm site:check:source && pnpm test:site && pnpm verify:fast`
Expected: all three exit 0.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/pipeline.yml lefthook.yml package.json
git commit -m "ci(site): check links, test the resolver, deploy _site"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (live-docs section)
- Modify: `AGENTS.md` §2 (line 29) and §4
- Modify: `ARCHITECTURE.md` §8.3 (lines 116-118)

**Interfaces:**
- Consumes: the final route set (`/`, `/api/`, `/guide/`).

- [ ] **Step 1: Update the three documents**

README: replace the "Live Docs" pointer with the three routes and one line saying the site is authored in `site/` and assembled by `pnpm site:build`. AGENTS.md §2: the live-docs line names the site root plus `/api` and `/guide`. AGENTS.md §4: the deploy stage publishes `_site`, not `docs`. ARCHITECTURE.md §8.3: `TypeDoc + cargo doc → assembled _site → Pages`.

- [ ] **Step 2: Verify no stale route text remains**

Run: `rg -n "unified (docs-root|index)|deploys? .{0,12}docs/|ckir.github.io/corelib/index.html" README.md AGENTS.md ARCHITECTURE.md`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add README.md AGENTS.md ARCHITECTURE.md
git commit -m "docs: point the docs at the site, /api and /guide"
```
