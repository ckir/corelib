import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	coreFFI,
	getVersion,
	isFfiAvailable,
	logAndDouble,
} from "@ckir/corelib";
import { ffiDescribe } from "@itest/_harness/guards";
import { describe, expect, it } from "vitest";

const pkgVersion = JSON.parse(
	readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8"),
).version as string;

ffiDescribe("ffi-scalar (real native boundary)", () => {
	it("[ffi.getVersion] returns the crate version equal to package.json", () => {
		expect(getVersion()).toBe(pkgVersion); // crate ↔ package sync check
	});

	it("[ffi.logAndDouble] returns the Rust-computed double (not the JS fallback)", () => {
		expect(logAndDouble("itest", 21)).toBe(42);
	});

	it("[ffi.isFfiAvailable] is true when the addon loaded", () => {
		expect(isFfiAvailable()).toBe(true);
		expect(coreFFI).toBeTruthy();
	});
});

describe("ffi availability fallback", () => {
	it("[ffi.availabilityFallback] isFfiAvailable() is a boolean and never throws", () => {
		expect(typeof isFfiAvailable()).toBe("boolean"); // contract: safe to call even when addon missing
	});
});
