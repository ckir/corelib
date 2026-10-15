// =============================================
// FILE: ts-markets/src/test-utils/mongo.test.ts
// PURPOSE: Unit tests for the pure mongoGate decision (skip vs run vs fail).
// Never calls describeMongo: its fail outcome would register a failing test.
// =============================================

import { describe, expect, it } from "vitest";
import { mongoGate, uniqueDatabaseName } from "./mongo";

const URI = "mongodb://127.0.0.1:27099";

describe("mongoGate", () => {
	it("skips when nothing is set", () => {
		expect(mongoGate({}).kind).toBe("skip");
	});

	it("runs with the URI when it is set", () => {
		expect(mongoGate({ CORELIB_TEST_MONGODB_URI: URI })).toEqual({
			kind: "run",
			uri: URI,
		});
	});

	it("fails when the switch is 1 and the URI is missing", () => {
		expect(mongoGate({ CORELIB_REQUIRE_MONGODB: "1" }).kind).toBe("fail");
	});

	it("runs when the switch is 1 and the URI is set", () => {
		expect(
			mongoGate({
				CORELIB_REQUIRE_MONGODB: "1",
				CORELIB_TEST_MONGODB_URI: URI,
			}),
		).toEqual({
			kind: "run",
			uri: URI,
		});
	});

	it("skips for a switch value other than exactly 1", () => {
		for (const value of ["0", "true", "yes", "", "11"]) {
			expect(mongoGate({ CORELIB_REQUIRE_MONGODB: value }).kind).toBe("skip");
		}
	});

	it("treats an empty URI as missing", () => {
		expect(mongoGate({ CORELIB_TEST_MONGODB_URI: "" }).kind).toBe("skip");
		expect(
			mongoGate({ CORELIB_REQUIRE_MONGODB: "1", CORELIB_TEST_MONGODB_URI: "" })
				.kind,
		).toBe("fail");
	});

	it("does not infer fail from CI", () => {
		expect(mongoGate({ CI: "true" }).kind).toBe("skip");
	});
});

describe("uniqueDatabaseName", () => {
	it("is a valid, unique Mongo database name", () => {
		const a = uniqueDatabaseName("src/stores/Mongo.Symbol-store.test.ts");
		const b = uniqueDatabaseName("src/stores/Mongo.Symbol-store.test.ts");
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9_]+$/);
		expect(a.length).toBeLessThanOrEqual(63);
	});
});
