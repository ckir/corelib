import { describe, expect, it } from "vitest";
import { checkProxyTarget } from "./url-guard";

describe("checkProxyTarget", () => {
	it.each([
		"https://api.nasdaq.com/api/quote/AAPL/info",
		"http://example.com/path?x=1",
		"https://93.184.216.34/",
		"https://[2606:2800:220:1:248:1893:25c8:1946]/",
	])("allows public target %s", (url) => {
		expect(checkProxyTarget(url)).toBeNull();
	});

	it.each([
		// cloud metadata + loopback + RFC1918 + link-local + CGNAT
		"http://169.254.169.254/latest/meta-data/",
		"http://169.254.170.2/v2/credentials",
		"http://127.0.0.1:8080/",
		"http://10.0.0.5/",
		"http://172.16.0.1/",
		"http://172.31.255.255/",
		"http://192.168.1.1/",
		"http://100.64.0.1/",
		"http://0.0.0.0/",
		"http://224.0.0.1/",
		// encodings WHATWG URL canonicalizes to the above
		"http://2130706433/",
		"http://0x7f.1/",
		"http://0177.0.0.1/",
		"http://127.1/",
		// IPv6 forms
		"http://[::1]/",
		"http://[::]/",
		"http://[fe80::1]/",
		"http://[fc00::1]/",
		"http://[fd12:3456::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:169.254.169.254]/",
		"http://[64:ff9b::7f00:1]/",
		// names that are internal by convention
		"http://localhost/",
		"http://LOCALHOST:3000/",
		"http://foo.localhost/",
		"http://printer.local/",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://trailing-dot.localhost./",
	])("blocks internal target %s", (url) => {
		expect(checkProxyTarget(url)).toEqual(expect.any(String));
	});

	it.each([
		"file:///etc/passwd",
		"ftp://example.com/",
		"gopher://example.com/",
		"javascript:alert(1)",
		"data:text/plain,hi",
	])("blocks non-http(s) scheme %s", (url) => {
		expect(checkProxyTarget(url)).toEqual(expect.any(String));
	});

	it("blocks credentials embedded in the URL", () => {
		expect(checkProxyTarget("https://user:pw@example.com/")).toEqual(
			expect.any(String),
		);
	});

	it("rejects unparseable input", () => {
		expect(checkProxyTarget("not a url")).toEqual(expect.any(String));
		expect(checkProxyTarget("")).toEqual(expect.any(String));
	});

	describe("allowedHostSuffixes", () => {
		const opts = { allowedHostSuffixes: ["nasdaq.com"] };

		it("allows the domain and its subdomains", () => {
			expect(checkProxyTarget("https://nasdaq.com/x", opts)).toBeNull();
			expect(checkProxyTarget("https://api.nasdaq.com/x", opts)).toBeNull();
		});

		it("rejects look-alike hosts", () => {
			expect(checkProxyTarget("https://evilnasdaq.com/", opts)).toEqual(
				expect.any(String),
			);
			expect(checkProxyTarget("https://nasdaq.com.evil.io/", opts)).toEqual(
				expect.any(String),
			);
			expect(checkProxyTarget("https://example.com/", opts)).toEqual(
				expect.any(String),
			);
		});

		it("still blocks internal addresses even if listed", () => {
			expect(
				checkProxyTarget("http://127.0.0.1/", {
					allowedHostSuffixes: ["127.0.0.1"],
				}),
			).toEqual(expect.any(String));
		});
	});
});
