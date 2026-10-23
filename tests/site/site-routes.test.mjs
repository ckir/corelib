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

	it("rejects a query string", () => {
		expect(() => normaliseBase("corelib?v=1")).toThrow(/base must be a path/);
	});

	it("rejects a fragment", () => {
		expect(() => normaliseBase("/corelib#top")).toThrow(/base must be a path/);
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
		expect(
			resolveTarget("https://github.com/ckir/corelib", "/", "/corelib"),
		).toEqual({ type: "external" });
	});

	it("strips the cache-busting query", () => {
		expect(
			resolveTarget("{{BASE}}/assets/site.css?v=0.4.0", "/", "/corelib"),
		).toEqual({ type: "internal", path: "/assets/site.css", hash: "" });
	});

	it("resolves a root escape to the site root, never //", () => {
		expect(resolveTarget("../", "/api/", "/corelib")).toEqual({
			type: "internal",
			path: "/",
			hash: "",
		});
	});

	it("maps a base-equal path to the site root", () => {
		expect(resolveTarget("/corelib", "/api/", "/corelib")).toEqual({
			type: "internal",
			path: "/",
			hash: "",
		});
	});

	it("splits a hash off an internal route link", () => {
		expect(resolveTarget("{{BASE}}/api/#core", "/", "/corelib")).toEqual({
			type: "internal",
			path: "/api/",
			hash: "core",
		});
	});

	it("keeps directory semantics for a bare dot segment", () => {
		expect(resolveTarget(".", "/api/", "/corelib")).toEqual({
			type: "internal",
			path: "/api/",
			hash: "",
		});
	});

	it("keeps directory semantics for a bare dot-dot segment", () => {
		expect(resolveTarget("..", "/api/", "/corelib")).toEqual({
			type: "internal",
			path: "/",
			hash: "",
		});
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
		expect([...extractIds('<h2 id="packages">x</h2><div id="start">')]).toEqual(
			["packages", "start"],
		);
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
			pages: [
				{ route: "/", html: '<link href="{{BASE}}/assets/missing.css">' },
			],
			...known,
		});
		expect(errors[0]).toMatch(/unknown asset: \/assets\/missing.css/);
	});

	it("rejects an empty fragment", () => {
		const errors = checkPages({
			pages: [{ route: "/", html: '<a href="#">x</a>' }],
			...known,
		});
		expect(errors[0]).toMatch(/empty fragment/);
	});

	it("rejects a fragment with no matching id", () => {
		const errors = checkPages({
			pages: [{ route: "/", html: '<a href="#missing">x</a>' }],
			...known,
		});
		expect(errors[0]).toMatch(/missing anchor: #missing/);
	});

	it("rejects a protocol-relative src", () => {
		const errors = checkPages({
			pages: [{ route: "/", html: '<img src="//cdn.example.com/x.png">' }],
			...known,
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/protocol-relative URL/);
	});

	it("rejects a renamed anchor referenced via {{BASE}}/ + hash", () => {
		const errors = checkPages({
			pages: [{ route: "/", html: '<a href="{{BASE}}/#gone">gone</a>' }],
			...known,
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/missing anchor: #gone/);
	});

	it("rejects an empty fragment via the {{BASE}} token form", () => {
		const errors = checkPages({
			pages: [{ route: "/", html: '<a href="{{BASE}}/#">x</a>' }],
			...known,
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/empty fragment/);
	});

	it("requires the {{BASE}} token on internal links in source mode", () => {
		const errors = checkPages({
			pages: [
				{
					route: "/",
					html: '<h1 id="top">x</h1><a href="/api/">tokenless</a><a href="{{BASE}}/#top">top</a>',
				},
			],
			...known,
			requireBaseToken: true,
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/^missing \{\{BASE\}\} token: \/api\//);
	});

	it("accepts tokenless internal links in build mode (tokens already expanded)", () => {
		const errors = checkPages({
			pages: [{ route: "/", html: '<a href="/api/">expanded</a>' }],
			...known,
		});
		expect(errors).toEqual([]);
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

	it.each([
		["site/index.html", "/"],
		["_site/api/index.html", "/api/"],
		["site\\404.html", "/404.html"],
		["./index.html", "/"],
	])("maps %j to %s across prefixes and separators", (file, route) => {
		expect(routeForFile(file)).toBe(route);
	});
});
