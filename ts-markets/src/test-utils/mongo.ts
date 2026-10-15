// =============================================
// FILE: ts-markets/src/test-utils/mongo.ts
// PURPOSE: Test helper that gates real-MongoDB suites on CORELIB_TEST_MONGODB_URI.
// A missing URI skips, unless CORELIB_REQUIRE_MONGODB is exactly "1" (then it fails).
// =============================================

import { describe, it } from "vitest";

const URI_VAR = "CORELIB_TEST_MONGODB_URI";
const REQUIRE_VAR = "CORELIB_REQUIRE_MONGODB";
const FAIL_TEST_NAME = `${REQUIRE_VAR}=1 but ${URI_VAR} is not set`;

export type MongoGate =
	| { kind: "run"; uri: string }
	| { kind: "skip"; message: string }
	| { kind: "fail"; message: string };

/** Pure decision: run, skip, or fail. An empty URI counts as missing; the switch counts only when exactly "1". */
export function mongoGate(env: Record<string, string | undefined>): MongoGate {
	const uri = env[URI_VAR];
	if (uri !== undefined && uri !== "") {
		return { kind: "run", uri };
	}
	if (env[REQUIRE_VAR] === "1") {
		return { kind: "fail", message: FAIL_TEST_NAME };
	}
	return {
		kind: "skip",
		message: `${URI_VAR} is not set; skipping real-MongoDB tests`,
	};
}

/** The configured connection string, or undefined when missing or empty. */
export function mongoTestUri(): string | undefined {
	const gate = mongoGate(process.env);
	return gate.kind === "run" ? gate.uri : undefined;
}

/** describe() against a real MongoDB, skipped (with a console note) or failed per mongoGate(process.env). */
export function describeMongo(name: string, fn: (uri: string) => void): void {
	const gate = mongoGate(process.env);
	switch (gate.kind) {
		case "run":
			describe(name, () => fn(gate.uri));
			return;
		case "skip":
			console.warn(`[${name}] ${gate.message}`);
			describe.skip(name, () => fn(""));
			return;
		case "fail":
			describe(name, () => {
				it(gate.message, () => {
					throw new Error(gate.message);
				});
			});
			return;
	}
}

/** A valid, unique Mongo database name: sanitized file stem plus a random suffix (max 63 chars). */
export function uniqueDatabaseName(file: string): string {
	const stem = (file.split(/[\\/]/).pop() ?? "test")
		.replace(/[^A-Za-z0-9_]/g, "_")
		.slice(0, 40);
	const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
	return `t_${stem}_${suffix}`.slice(0, 63);
}
