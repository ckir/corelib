import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	ASSET_FILES,
	GENERATED_FILES,
	GENERATED_ROUTES,
	normaliseBase,
	routeForFile,
} from "./site-routes.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

/**
 * Replace {{BASE}} and {{VERSION}} tokens in HTML content.
 * @param {string} html
 * @param {{base: string, version: string}} opts
 * @returns {string}
 */
export function substitute(html, { base, version }) {
	let result = String(html ?? "");
	result = result.replaceAll("{{BASE}}", base);
	result = result.replaceAll("{{VERSION}}", version);
	return result;
}

/**
 * Detect the single crate directory under rustDocsDir that contains index.html.
 * @param {string} rustDocsDir
 * @returns {string}
 */
export function detectCrateDir(rustDocsDir) {
	if (!existsSync(rustDocsDir)) {
		throw new Error(`missing ${rustDocsDir}: run pnpm docs-all first`);
	}
	let entries;
	try {
		entries = readdirSync(rustDocsDir, { withFileTypes: true });
	} catch (err) {
		if (err instanceof Error) {
			throw new Error(`missing ${rustDocsDir}: run pnpm docs-all first`);
		}
		throw err;
	}
	const dirs = entries.filter((e) => e.isDirectory());
	const candidates = [];
	for (const d of dirs) {
		const indexPath = join(rustDocsDir, d.name, "index.html");
		if (existsSync(indexPath)) {
			candidates.push(d.name);
		}
	}
	if (candidates.length !== 1) {
		throw new Error(`expected exactly one crate directory in ${rustDocsDir}, found ${candidates.length}`);
	}
	return candidates[0];
}

/**
 * Render the API index page.
 * @param {{base: string, version: string, packages: Array<{name: string, slug: string}>}} opts
 * @returns {string}
 */
export function renderApiIndex({ base, version, packages }) {
	const cards = packages
		.map(
			(pkg) => `
        <a class="card" href="${base}/api/${pkg.slug}/">
          <div class="card-head">
            <div class="badge"><svg width="22" height="22" aria-hidden="true" focusable="false"><use href="#cube"/></svg></div>
            <div>
              <h2>${pkg.name}</h2>
              <div class="meta">v${version}</div>
            </div>
          </div>
          <div class="arrow">Browse docs →</div>
        </a>`,
		)
		.join("\n");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API reference — corelib</title>
<meta name="description" content="API reference for @ckirg/corelib, @ckirg/corelib-markets, @ckirg/corelib-cloud and corelib-rust.">
<meta name="theme-color" content="#070b18">
<link rel="icon" type="image/svg+xml" href="${base}/assets/favicon.svg">
<link rel="stylesheet" href="${base}/assets/site.css?v=${version}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="ambient" aria-hidden="true"></div>

<svg class="sprite" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="gTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#7c3aed"/></linearGradient>
    <linearGradient id="gLeft" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d28d9"/><stop offset="1" stop-color="#4c1d95"/></linearGradient>
    <linearGradient id="gRight" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4338ca"/><stop offset="1" stop-color="#7c3aed"/></linearGradient>
    <linearGradient id="gAccent" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a855f7"/><stop offset="1" stop-color="#3b82f6"/></linearGradient>
    <symbol id="cube" viewBox="0 0 200 200">
      <polygon points="100,14 176,58 100,102 24,58" fill="url(#gTop)"/>
      <polygon points="24,58 100,102 100,186 24,142" fill="url(#gLeft)"/>
      <polygon points="176,58 100,102 100,186 176,142" fill="url(#gRight)"/>
    </symbol>
  </defs>
</svg>

<header class="nav-shell">
  <div class="wrap">
    <nav class="nav" aria-label="Primary">
      <a class="nav-logo" href="${base}/"><svg class="cube" width="26" height="26" aria-hidden="true" focusable="false"><use href="#cube"/></svg>corelib</a>
      <div class="nav-links">
        <a href="${base}/#packages">Packages</a>
        <a href="${base}/#native">Native core</a>
        <a href="${base}/#start">Quickstart</a>
        <a href="${base}/api/">API</a>
      </div>
      <div class="nav-right">
        <span class="pill">v${version}</span>
      </div>
    </nav>
  </div>
</header>

<main id="main" tabindex="-1">
  <div class="wrap">
    <section class="block">
      <div class="eyebrow">Reference</div>
      <h1>API reference</h1>
      <p class="section-lede">Browse generated documentation for each package.</p>
      <p><a class="link" href="${base}/">← Back to home</a></p>
      <div class="pkg-grid">
${cards}
      </div>
    </section>
  </div>
</main>

<footer>
  <div class="wrap">
    <div class="foot-note"><span>© 2026 corelib · MIT</span><span>Built with pnpm, tsup and Rust</span></div>
  </div>
</footer>
</body>
</html>`;
}

/**
 * Copy directory recursively
 */
function copyDir(src, dest) {
	if (!existsSync(src)) {
		throw new Error(`missing ${src}: run pnpm docs-all first`);
	}
	mkdirSync(dest, { recursive: true });
	const entries = readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDir(srcPath, destPath);
		} else if (entry.isFile()) {
			cpSync(srcPath, destPath);
		}
	}
}

/**
 * Copy directory substituting tokens in .html files
 */
function copyDirSubstitute(src, dest, base, version) {
	if (!existsSync(src)) {
		throw new Error(`missing ${src}: run pnpm docs-all first`);
	}
	mkdirSync(dest, { recursive: true });
	const entries = readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirSubstitute(srcPath, destPath, base, version);
		} else if (entry.isFile()) {
			if (entry.name.endsWith(".html")) {
				const content = readFileSync(srcPath, "utf8");
				const substituted = substitute(content, { base, version });
				writeFileSync(destPath, substituted);
			} else {
				cpSync(srcPath, destPath);
			}
		}
	}
}

function build() {
	const base = normaliseBase(process.env.SITE_BASE ?? "/corelib");
	
	// Read version from root package.json
	const rootPkgPath = join(ROOT, "package.json");
	if (!existsSync(rootPkgPath)) {
		throw new Error(`missing ${rootPkgPath}`);
	}
	const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
	const version = rootPkg.version;

	const siteDir = join(ROOT, "site");
	const outDir = join(ROOT, "_site");
	const tsCoreDocs = join(ROOT, "ts-core", "docs");
	const tsMarketsDocs = join(ROOT, "ts-markets", "docs");
	const tsCloudDocs = join(ROOT, "ts-cloud", "docs");
	const rustDocs = join(ROOT, "rust", "docs");
	const userGuideHtml = join(ROOT, "docs", "USER_GUIDE.html");
	const userGuidePdf = join(ROOT, "docs", "USER_GUIDE.pdf");

	// Assert all source paths exist
	if (!existsSync(siteDir)) throw new Error(`missing ${siteDir}: run pnpm docs-all first`);
	if (!existsSync(tsCoreDocs)) throw new Error(`missing ${tsCoreDocs}: run pnpm docs-all first`);
	if (!existsSync(tsMarketsDocs)) throw new Error(`missing ${tsMarketsDocs}: run pnpm docs-all first`);
	if (!existsSync(tsCloudDocs)) throw new Error(`missing ${tsCloudDocs}: run pnpm docs-all first`);
	if (!existsSync(rustDocs)) throw new Error(`missing ${rustDocs}: run pnpm docs-all first`);
	if (!existsSync(userGuideHtml)) throw new Error(`missing ${userGuideHtml}: run pnpm docs-all first`);
	if (!existsSync(userGuidePdf)) throw new Error(`missing ${userGuidePdf}: run pnpm docs-all first`);

	// rmSync _site
	rmSync(outDir, { recursive: true, force: true });

	// copy site/ -> _site/ substituting tokens in .html files only
	copyDirSubstitute(siteDir, outDir, base, version);

	// copy docs to api/
	mkdirSync(join(outDir, "api"), { recursive: true });
	copyDir(tsCoreDocs, join(outDir, "api", "core"));
	copyDir(tsMarketsDocs, join(outDir, "api", "markets"));
	copyDir(tsCloudDocs, join(outDir, "api", "cloud"));

	// rust
	const crateDir = detectCrateDir(rustDocs);
	copyDir(join(rustDocs, crateDir), join(outDir, "api", "rust", crateDir));
	// write meta-refresh redirect
	const rustIndexContent = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${crateDir}/index.html">
<title>Redirecting…</title>
</head>
<body>
<p>Redirecting to <a href="${base}/api/">Browse all API docs</a>…</p>
</body>
</html>`;
	writeFileSync(join(outDir, "api", "rust", "index.html"), rustIndexContent);

	// copy guide
	mkdirSync(join(outDir, "guide"), { recursive: true });
	cpSync(userGuideHtml, join(outDir, "guide", "index.html"));
	cpSync(userGuidePdf, join(outDir, "guide", "USER_GUIDE.pdf"));

	// write api/index.html
	const apiIndex = renderApiIndex({
		base,
		version,
		packages: [
			{ name: "@ckirg/corelib", slug: "core" },
			{ name: "@ckirg/corelib-markets", slug: "markets" },
			{ name: "@ckirg/corelib-cloud", slug: "cloud" },
			{ name: "corelib-rust", slug: "rust" },
		],
	});
	writeFileSync(join(outDir, "api", "index.html"), apiIndex);

	// write .nojekyll
	writeFileSync(join(outDir, ".nojekyll"), "");

	// write .site-base (empty when base is "")
	writeFileSync(join(outDir, ".site-base"), base);

	// count files
	let fileCount = 0;
	function countFiles(dir) {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				countFiles(fullPath);
			} else if (entry.isFile()) {
				fileCount++;
			}
		}
	}
	countFiles(outDir);

	process.stdout.write(`site: built ${fileCount} files into _site\n`);

	// spawn checker
	const checker = spawnSync("node", [join(ROOT, "scripts", "check-site.mjs")], {
		stdio: "inherit",
		cwd: ROOT,
	});
	process.exitCode = checker.status ?? 1;
}

// Run CLI only when executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	build();
}
