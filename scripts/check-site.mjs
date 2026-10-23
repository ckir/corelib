/**
 * Link checker CLI for the static site pipeline (Task 2).
 *
 * Usage:
 * - `node scripts/check-site.mjs --source` — checks the *authored* pages
 *   (`site/index.html`, `site/404.html`) with `requireBaseToken: true`, so every
 *   internal link must be authored as `{{BASE}}/path`; this is the only mode that
 *   sees the unexpanded HTML where that rule is enforceable. Base comes from
 *   `process.env.SITE_BASE ?? DEFAULT_BASE`.
 * - `node scripts/check-site.mjs` (default, build mode) — checks the four pages
 *   assembled by the build under `_site/` (`--root <dir>` overrides `_site`).
 *   `{{BASE}}` tokens are already expanded there, so `requireBaseToken` is off and
 *   the base is read from `_site/.site-base` (what the build actually applied).
 *   Known files are the build's own outputs under `assets/` and `guide/` plus
 *   `GENERATED_FILES`; the generated TypeDoc/rustdoc trees are not parsed.
 *
 * Exit codes: 0 clean, 1 with one line per check error on stderr, 2 for usage or
 * missing-input problems (one-line message on stderr).
 */
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
	ASSET_FILES,
	AUTHORED_PAGES,
	checkPages,
	DEFAULT_BASE,
	GENERATED_FILES,
	GENERATED_ROUTES,
	normaliseBase,
	routeForFile,
} from "./site-routes.mjs";

const USAGE = "usage: node scripts/check-site.mjs [--source] [--root <dir>]";

/** Pages the build assembles under `_site/` (relative to the build root). */
const BUILD_PAGES = [
	"index.html",
	"404.html",
	"api/index.html",
	"api/rust/index.html",
];

/** Build subdirectories whose files the pages may reference directly. */
const BUILD_SEGMENTS = ["assets", "guide"];

/** The home and not-found routes are always known; GENERATED_ROUTES add the rest. */
const ALWAYS_KNOWN_ROUTES = [...GENERATED_ROUTES, "/", "/404.html"];

/**
 * Runtime marker distinguishing "missing input" (exit 2, one-line message) from
 * unexpected failures.
 */
const NOT_FOUND = Symbol("notFound");

/**
 * @param {string} message one-line stderr message
 * @returns {Error} an error carrying the {@link NOT_FOUND} marker
 */
function notFoundError(message) {
	/** @type {Error & {[NOT_FOUND]?: true}} */
	const error = new Error(message);
	error[NOT_FOUND] = true;
	return error;
}

/**
 * List every regular file under `<root>/<segment>` recursively (readdirSync with
 * `withFileTypes`, no glob dependency) as site-absolute paths. A missing segment
 * directory simply contributes no files — `checkPages` then reports any page that
 * links into it as an unknown asset.
 * @param {string} root build root directory, e.g. "_site"
 * @param {string} segment subdirectory name, e.g. "assets"
 * @returns {string[]} e.g. ["/assets/site.css"]
 */
function collectBuildFiles(root, segment) {
	const files = [];
	const walk = /** @param {string} rel */ (rel) => {
		for (const entry of readdirSync(`${root}/${rel}`, {
			withFileTypes: true,
		}).sort((a, b) => a.name.localeCompare(b.name))) {
			const child = `${rel}/${entry.name}`;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) files.push(`/${child}`);
		}
	};
	try {
		walk(segment);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT"
		) {
			throw error;
		}
	}
	return files;
}

/**
 * Read a text file, returning `undefined` instead of throwing when it is absent.
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
async function readTextFile(path) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Parse CLI arguments. Anything that is not `--source`, `--root <dir>` (including
 * a bare positional or a missing `--root` value) is a wrong invocation.
 * @param {string[]} argv raw arguments after the script path
 * @returns {{source: boolean, root: string} | undefined} the options, or
 *   `undefined` when the usage line should be printed
 */
function parseArgs(argv) {
	const options = { source: false, root: "_site" };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--source") {
			options.source = true;
		} else if (arg === "--root") {
			const value = argv[i + 1] ?? "";
			if (value === "") return undefined;
			options.root = value;
			i++;
		} else {
			return undefined;
		}
	}
	return options;
}

/**
 * @param {string} root build root directory
 * @returns {Promise<{route: string, html: string}[]>} the four assembled pages
 * @throws {Error} carrying {@link NOT_FOUND} on the first missing page
 */
async function readBuildPages(root) {
	const pages = [];
	for (const rel of BUILD_PAGES) {
		const html = await readTextFile(`${root}/${rel}`);
		if (html === undefined) {
			throw notFoundError(`${root}/${rel} not found`);
		}
		pages.push({ route: routeForFile(rel), html });
	}
	return pages;
}

/**
 * @returns {Promise<{route: string, html: string}[]>} the authored pages
 * @throws {Error} carrying {@link NOT_FOUND} on the first missing page
 */
async function readSourcePages() {
	const pages = [];
	for (const rel of AUTHORED_PAGES) {
		const html = await readTextFile(rel);
		if (html === undefined) {
			throw notFoundError(`${rel} not found: run Task 3 first`);
		}
		pages.push({ route: routeForFile(rel), html });
	}
	return pages;
}

/**
 * @returns {Promise<number>} process exit code: 0 clean, 1 check errors, 2 usage
 *   or missing input
 */
async function run() {
	const options = parseArgs(process.argv.slice(2));
	if (!options) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	const { source, root } = options;
	const baseFile = `${root}/.site-base`;
	const base = source
		? normaliseBase(process.env.SITE_BASE ?? DEFAULT_BASE)
		: (await readTextFile(baseFile))?.trim();
	if (!source && base === undefined) {
		process.stderr.write(`${baseFile} not found\n`);
		return 2;
	}
	const pages = source ? await readSourcePages() : await readBuildPages(root);
	const knownFiles = source
		? [...ASSET_FILES, ...GENERATED_FILES]
		: [
				...GENERATED_FILES,
				...BUILD_SEGMENTS.flatMap((segment) =>
					collectBuildFiles(root, segment),
				),
			];
	const errors = checkPages({
		pages,
		knownRoutes: ALWAYS_KNOWN_ROUTES,
		knownFiles,
		base,
		requireBaseToken: source,
	});
	if (errors.length > 0) {
		for (const error of errors) process.stderr.write(`${error}\n`);
		return 1;
	}
	process.stdout.write(`site: ${pages.length} pages checked, no problems\n`);
	return 0;
}

// Unexpected failures (e.g. an invalid `SITE_BASE` rejected by `normaliseBase`)
// also exit 2 with a one-line message; NOT_FOUND errors carry that message already.
const code = await run().catch(
	/** @param {unknown} error */ (error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 2;
	},
);
process.exitCode = code;
