/**
 * Route table and reference resolver for the static site pipeline.
 *
 * Pure module: no network, no filesystem, no dependencies.
 * Consumed by two callers:
 * - `scripts/build-site.mjs` (Task 5) — route mapping, base normalisation, constants.
 * - `scripts/check-site.mjs` (Task 2) — ref extraction, target resolution and page
 *   checking (`checkPages` is the checker's core logic, covered by task-1 tests).
 *
 * Conventions:
 * - Authored internal links are written `{{BASE}}/path` (leading slash after the token).
 * - `{{BASE}}` normalises to `""` (domain root) or `"/corelib"` (no trailing slash);
 *   site-relative paths returned by `resolveTarget` have the base stripped, so checks
 *   compare against `GENERATED_ROUTES` regardless of deployment base.
 * - Directory routes keep a trailing slash; files do not.
 */

/** Deployment base used when `SITE_BASE` is unset (Task 2: `process.env.SITE_BASE ?? DEFAULT_BASE`). */
export const DEFAULT_BASE = "/corelib";

/** Authored page files, relative to the repo root (`--source` mode reads these). */
export const AUTHORED_PAGES = ["site/index.html", "site/404.html"];

/** Directory routes produced by the docs/build pipeline (keep trailing slash). */
export const GENERATED_ROUTES = [
	"/api/",
	"/api/core/",
	"/api/markets/",
	"/api/cloud/",
	"/api/rust/",
	"/guide/",
];

/** Files produced by the build that pages may reference directly (no trailing slash). */
export const GENERATED_FILES = ["/guide/index.html", "/guide/USER_GUIDE.pdf"];

/** Site asset files copied verbatim from `site/assets/`. */
export const ASSET_FILES = [
	"/assets/site.css",
	"/assets/favicon.svg",
	"/assets/site.js",
];

/**
 * Normalise a raw base value to `""` or `"/<name>"` (no leading/trailing slashes).
 * Throws for anything that is not a plain path: absolute/protocol-relative URLs
 * (containing `://`), `?` and `#`.
 * @param {string} raw
 * @returns {string}
 */
export function normaliseBase(raw) {
	const value = String(raw ?? "");
	if (value.includes("://") || value.includes("?") || value.includes("#")) {
		throw new Error(`base must be a path, got "${value}"`);
	}
	const segments = value
		.replace(/\/+$/, "")
		.replace(/^\/+/, "")
		.split("/")
		.filter(Boolean);
	return segments.length > 0 ? `/${segments.join("/")}` : "";
}

/**
 * Map a page file path to its site route. `site/` and `_site/` prefixes are ignored
 * (Windows path separators normalised), so both `site/index.html` and `index.html`
 * map to `/`.
 * @param {string} relPath e.g. "site/api/index.html" | "api/index.html" | "404.html"
 * @returns {string} route, e.g. "/api/" — "/404.html" keeps the file name.
 */
export function routeForFile(relPath) {
	const rel = String(relPath)
		.replaceAll("\\", "/")
		.replace(/^(?:site\/|_site\/)/, "")
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".")
		.join("/");
	const indexSuffix = "/index.html";
	if (rel === "index.html") return "/";
	if (rel === "404.html") return "/404.html";
	if (rel.endsWith(indexSuffix))
		return `/${rel.slice(0, -indexSuffix.length)}/`;
	return `/${rel}`;
}

/**
 * Extract every `href="..."` and `src="..."` value from HTML in document order.
 * @param {string} html
 * @returns {{attr: "href"|"src", value: string}[]}
 */
export function extractRefs(html) {
	const refs = [];
	for (const match of String(html ?? "").matchAll(
		/(?:^|\s)(href|src)\s*=\s*"([^"]*)"/g,
	)) {
		refs.push({
			attr: /** @type {"href"|"src"} */ (match[1]),
			value: match[2] ?? "",
		});
	}
	return refs;
}

/**
 * Extract every `id="..."` value from HTML into a Set.
 * @param {string} html
 * @returns {Set<string>}
 */
export function extractIds(html) {
	const ids = new Set();
	for (const match of String(html ?? "").matchAll(
		/(?:^|\s)id\s*=\s*"([^"]+)"/g,
	)) {
		ids.add(match[1] ?? "");
	}
	return ids;
}

/**
 * Resolve a relative path against a page route (dot-segment aware).
 * "/api/" + "../guide/" → "/guide/"; a trailing slash in the input is preserved,
 * and a bare `.`/`..` last segment resolves to a directory, so it keeps a slash.
 * @param {string} path already-absolute ("/x") or page-relative path, no query/hash
 * @param {string} pageRoute route of the page containing the reference
 * @returns {string}
 */
function resolveAgainstRoute(path, pageRoute) {
	if (path.startsWith("/")) return path;
	const rawSegments = path.split("/");
	const lastRawSegment = rawSegments[rawSegments.length - 1] ?? "";
	const asDirectory =
		path.endsWith("/") || lastRawSegment === "." || lastRawSegment === "..";
	const directory = pageRoute.endsWith("/")
		? pageRoute
		: `${pageRoute.slice(0, pageRoute.lastIndexOf("/") + 1) || "/"}`;
	const segments = `${directory}${path}`.split("/");
	const stack = [];
	for (const segment of segments) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") stack.pop();
		else stack.push(segment);
	}
	if (stack.length === 0) return "/";
	return `/${stack.join("/")}${asDirectory ? "/" : ""}`;
}

/**
 * Classify and resolve one reference value.
 * `{{BASE}}` is expanded first, external URLs and protocol-relative URLs get their
 * own result types, the query string is dropped, `#` is split into `hash`, relative
 * paths resolve against the page route, and the normalised base prefix is stripped.
 * @param {string} ref reference value, e.g. `{{BASE}}/api/` | "../guide/" | "#packages"
 * @param {string} pageRoute route of the page containing the reference
 * @param {string} base normalised deployment base ("" = domain root)
 * @returns {{type: "external"} | {type: "protocol-relative"} | {type: "same-document", hash: string} | {type: "internal", path: string, hash: string}}
 */
export function resolveTarget(ref, pageRoute, base) {
	let value = String(ref ?? "").replaceAll("{{BASE}}", normaliseBase(base));
	if (!value.startsWith("//") && value.includes("://")) {
		return { type: "external" };
	}
	if (value.startsWith("//")) {
		return { type: "protocol-relative" };
	}
	if (value.startsWith("#")) {
		return { type: "same-document", hash: value.slice(1) };
	}
	let hash = "";
	const hashIndex = value.indexOf("#");
	if (hashIndex !== -1) {
		hash = value.slice(hashIndex + 1).split("?")[0];
		value = value.slice(0, hashIndex);
	}
	const queryIndex = value.indexOf("?");
	if (queryIndex !== -1) value = value.slice(0, queryIndex);
	let path = resolveAgainstRoute(value, pageRoute);
	const normalisedBase = normaliseBase(base);
	if (normalisedBase) {
		if (path === normalisedBase) {
			path = "/";
		} else if (path.startsWith(`${normalisedBase}/`)) {
			path = path.slice(normalisedBase.length);
		}
	}
	return { type: "internal", path, hash };
}

/**
 * Check every page's references against the known route/file tables.
 * Error strings (one per problem, in document order):
 * - `protocol-relative URL: <ref>` — `//host` is a mistake, never a valid target;
 * - `empty fragment: <attr> "#"` — a `#` with no hash: either a bare `#` link or an
 *   internal link resolving back to the page's own route, e.g. `{{BASE}}/#`;
 * - `missing anchor: #<id>` — same-document hash with no matching id on the page
 *   (also raised for an internal target whose path resolves back to the page's own
 *   route, e.g. `{{BASE}}/#packages` on the home page);
 * - `missing {{BASE}} token: <ref>` — an internal link not authored as
 *   `{{BASE}}/path` (only with `requireBaseToken`, see below);
 * - `unknown route: <path>` — internal link ending `/` not in `knownRoutes`;
 * - `unknown asset: <path>` — internal file link not in `knownFiles`.
 * External URLs and internal links with hashes pointing at a different route are
 * ignored (cross-page anchors are not known here).
 *
 * `requireBaseToken` enforces the authoring rule that every internal link is written
 * `{{BASE}}/path`: with it enabled, any internal reference whose raw value does not
 * start with the `{{BASE}}` token is reported, because after token substitution such
 * a link would bypass the deployment base and 404 on GitHub Pages. Same-document
 * (`#anchor`) links are exempt. Task 2's `--source` mode authoring check passes
 * `true`; build mode passes `false` (the builder has already expanded the tokens).
 * @param {{pages: {route: string, html: string}[], knownRoutes: Iterable<string>, knownFiles: Iterable<string>, base?: string, requireBaseToken?: boolean}} input
 * @returns {string[]}
 */
export function checkPages({
	pages,
	knownRoutes,
	knownFiles,
	base,
	requireBaseToken = false,
}) {
	const routes = new Set(knownRoutes);
	const files = new Set(knownFiles);
	const normalisedBase = normaliseBase(base ?? "");
	const errors = [];
	for (const page of pages) {
		const ids = extractIds(page.html);
		for (const { attr, value } of extractRefs(page.html)) {
			const target = resolveTarget(value, page.route, normalisedBase);
			if (target.type === "external") continue;
			const where = ` (${attr} "${value}" in route ${page.route})`;
			if (target.type === "protocol-relative") {
				errors.push(`protocol-relative URL: ${value}${where}`);
				continue;
			}
			if (
				requireBaseToken &&
				target.type === "internal" &&
				!value.startsWith("{{BASE}}")
			) {
				errors.push(`missing {{BASE}} token: ${value}${where}`);
			}
			// Same-document: a plain `#hash`, or an internal target that resolves
			// back to this page's own route (e.g. `{{BASE}}/#packages` on `/`).
			// The raw value's `#` discriminates an intended fragment from a
			// hash-less link, so `{{BASE}}/#` is an empty fragment, not a route.
			const sameDocument =
				target.type === "same-document" ||
				(target.type === "internal" &&
					target.path === page.route &&
					value.includes("#"));
			if (sameDocument) {
				if (target.hash === "") {
					errors.push(`empty fragment: ${attr} "#"${where}`);
				} else if (!ids.has(target.hash)) {
					errors.push(`missing anchor: #${target.hash}${where}`);
				}
				continue;
			}
			if (target.type === "internal" && target.path.endsWith("/")) {
				if (!routes.has(target.path)) {
					errors.push(`unknown route: ${target.path}${where}`);
				}
				continue;
			}
			if (target.type === "internal" && !files.has(target.path)) {
				errors.push(`unknown asset: ${target.path}${where}`);
			}
		}
	}
	return errors;
}
