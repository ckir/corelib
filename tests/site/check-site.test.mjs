/**
 * Spawn-based Vitest coverage for `scripts/check-site.mjs` (the CLI shell around
 * `checkPages`, whose core logic is covered by `site-routes.test.mjs`).
 *
 * Source mode reads `site/` relative to the process cwd, so it **is** tested here
 * with per-test cwd fixtures — no new flag surface needed. Its happy path will
 * start passing as soon as Task 3 adds `site/index.html` / `site/404.html`; the
 * missing-page case below stays green through that transition.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "..", "..", "scripts", "check-site.mjs");
const USAGE =
	"usage: node scripts/check-site.mjs [--source] [--root <dir>]\n(--root applies to build mode only)";
const BUILD_SUCCESS = "site: 4 pages checked, no problems\n";
const SOURCE_SUCCESS = "site: 2 pages checked, no problems\n";

/** @type {string | undefined} */
let tempDir;

afterEach(() => {
	if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

/**
 * Create a populated build (`_site/`-style) tree, return its path.
 * @param {string} [rustPage] HTML for the `/api/rust/` page (inject a bad link)
 * @param {boolean} [withBase] whether `.site-base` exists
 * @returns {string}
 */
function makeTree(rustPage = `<a href="/api/">back</a>\n`, withBase = true) {
	const root = mkdtempSync(join(tmpdir(), "check-site-"));
	tempDir = root;
	mkdirSync(join(root, "api", "rust"), { recursive: true });
	mkdirSync(join(root, "assets"), { recursive: true });
	mkdirSync(join(root, "guide"), { recursive: true });
	writeFileSync(join(root, "index.html"), `<a href="/api/">\n`);
	writeFileSync(join(root, "404.html"), `<a href="/">\n`);
	writeFileSync(join(root, "api", "index.html"), `<a href="/api/rust/">\n`);
	writeFileSync(join(root, "api", "rust", "index.html"), rustPage);
	writeFileSync(join(root, "assets", "site.css"), "");
	writeFileSync(join(root, "guide", "index.html"), "");
	if (withBase) writeFileSync(join(root, ".site-base"), "/corelib\n");
	return root;
}

/**
 * Create an authored-source `site/` tree, return the cwd to spawn from.
 * @param {string} homePage HTML for `site/index.html`
 * @param {boolean} [withPages] whether the pages exist at all
 * @returns {string}
 */
function makeSourceCwd(
	homePage = `<a href="{{BASE}}/api/">\n`,
	withPages = true,
) {
	const root = mkdtempSync(join(tmpdir(), "check-site-src-"));
	tempDir = root;
	mkdirSync(join(root, "site"), { recursive: true });
	if (withPages) {
		writeFileSync(join(root, "site", "index.html"), homePage);
		writeFileSync(join(root, "site", "404.html"), "");
	}
	return root;
}

/**
 * Spawn the CLI.
 * @param {string[]} args CLI arguments
 * @param {string} [cwd] optional working directory (used by source fixtures)
 */
function runCli(args, cwd) {
	return spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		...(cwd === undefined ? {} : { cwd }),
	});
}

describe("check-site CLI", () => {
	it("exits 0 with exactly the success line on a clean build tree", () => {
		const result = runCli(["--root", makeTree()]);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(BUILD_SUCCESS);
		expect(result.stderr).toBe("");
	});

	it("accepts the inline --root=<dir> form", () => {
		const result = runCli([`--root=${makeTree()}`]);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(BUILD_SUCCESS);
	});

	it("exits 1 with exactly one stderr line naming the unknown route", () => {
		const result = runCli(["--root", makeTree(`<a href="/nope/">\n`)]);
		expect(result.status).toBe(1);
		const lines = result.stderr.split("\n").filter((line) => line !== "");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`unknown route: /nope/`);
		expect(lines[0]).toContain(`in route /api/rust/`);
		expect(result.stdout).toBe("");
	});

	it("exits 2 and names _site/.site-base when the base file is missing", () => {
		const root = makeTree(undefined, false);
		const result = runCli(["--root", root]);
		expect(result.status).toBe(2);
		expect(result.stderr).toBe(`${root}/.site-base not found\n`);
		expect(result.stdout).toBe("");
	});

	it("exits 2 with the usage message for an unknown flag", () => {
		const result = runCli(["--bogus", "--root", makeTree()]);
		expect(result.status).toBe(2);
		expect(result.stderr).toBe(`${USAGE}\n`);
		expect(result.stdout).toBe("");
	});

	it("treats a --root value starting with -- as missing", () => {
		const result = runCli(["--root", "--source"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toBe(`${USAGE}\n`);
	});

	it("rejects --root combined with --source", () => {
		const result = runCli(["--source", `--root=${tmpdir()}`]);
		expect(result.status).toBe(2);
		expect(result.stderr).toBe(`${USAGE}\n`);
	});

	it("exits 0 with the success line for a clean source tree", () => {
		const result = runCli(["--source"], makeSourceCwd());
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(SOURCE_SUCCESS);
		expect(result.stderr).toBe("");
	});

	it("enforces the {{BASE}} token rule in source mode", () => {
		const result = runCli(["--source"], makeSourceCwd(`<a href="/api/">\n`));
		expect(result.status).toBe(1);
		const lines = result.stderr.split("\n").filter((line) => line !== "");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`missing {{BASE}} token: /api/`);
		expect(result.stdout).toBe("");
	});

	it("exits 2 naming site/index.html while the pages do not exist", () => {
		// TODO(Task 3): this stays green after `site/` lands — then covers Task 2's
		// transition behaviour, not a permanently-missing tree.
		const result = runCli(["--source"], makeSourceCwd(undefined, false));
		expect(result.status).toBe(2);
		expect(result.stderr).toBe("site/index.html not found: run Task 3 first\n");
		expect(result.stdout).toBe("");
	});
});
