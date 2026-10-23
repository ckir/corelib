import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { substitute, detectCrateDir, renderApiIndex } from "../../scripts/build-site.mjs";

describe("build-site helpers", () => {
	let tempDirs = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
		tempDirs = [];
	});

	it("substitute replaces both tokens and leaves other text alone", () => {
		const html = '<link href="{{BASE}}/assets/site.css?v={{VERSION}}"><a href="{{BASE}}/">hi</a>';
		const result = substitute(html, { base: "/corelib", version: "1.2.3" });
		expect(result).toBe('<link href="/corelib/assets/site.css?v=1.2.3"><a href="/corelib/">hi</a>');
		expect(result).not.toContain("{{BASE}}");
		expect(result).not.toContain("{{VERSION}}");
	});

	describe("detectCrateDir", () => {
		it("returns the single dir with index.html", () => {
			const dir = mkdtempSync(join(tmpdir(), "crate-"));
			tempDirs.push(dir);
			const crate = join(dir, "corelib_rust");
			mkdirSync(crate, { recursive: true });
			writeFileSync(join(crate, "index.html"), "<html></html>");
			expect(detectCrateDir(dir)).toBe("corelib_rust");
		});

		it("throws /exactly one crate directory/ for zero", () => {
			const dir = mkdtempSync(join(tmpdir(), "crate-"));
			tempDirs.push(dir);
			expect(() => detectCrateDir(dir)).toThrow(/exactly one crate directory/);
		});

		it("throws /exactly one crate directory/ for two", () => {
			const dir = mkdtempSync(join(tmpdir(), "crate-"));
			tempDirs.push(dir);
			const crate1 = join(dir, "crate1");
			const crate2 = join(dir, "crate2");
			mkdirSync(crate1, { recursive: true });
			mkdirSync(crate2, { recursive: true });
			writeFileSync(join(crate1, "index.html"), "<html></html>");
			writeFileSync(join(crate2, "index.html"), "<html></html>");
			expect(() => detectCrateDir(dir)).toThrow(/exactly one crate directory/);
		});
	});

	describe("renderApiIndex", () => {
		it("contains one link per package and the supplied version", () => {
			const html = renderApiIndex({
				base: "/corelib",
				version: "0.4.0",
				packages: [
					{ name: "@ckirg/corelib", slug: "core" },
					{ name: "@ckirg/corelib-markets", slug: "markets" },
					{ name: "@ckirg/corelib-cloud", slug: "cloud" },
					{ name: "corelib-rust", slug: "rust" },
				],
			});
			expect(html).toContain("core/");
			expect(html).toContain("markets/");
			expect(html).toContain("cloud/");
			expect(html).toContain("rust/");
			expect(html).toContain("@ckirg/corelib");
			expect(html).toContain("@ckirg/corelib-markets");
			expect(html).toContain("@ckirg/corelib-cloud");
			expect(html).toContain("corelib-rust");
			expect(html).toContain("0.4.0");
			expect(html).not.toContain("{{");
		});
	});
});
