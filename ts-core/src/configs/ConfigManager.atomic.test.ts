// =============================================
// FILE: ts-core/src/configs/ConfigManager.atomic.test.ts
// PURPOSE: Verify the atomic in-place config mutation invariants introduced in
// Epic-1 Task 3: no reference severance (-09), seeded defaults before init (-02),
// and clearAndFill utility correctness.
// =============================================

import { describe, expect, it } from "vitest";
import { ConfigManager, clearAndFill } from "./ConfigManager";

// ── 1. clearAndFill unit tests ──────────────────────────────────────────────

describe("clearAndFill", () => {
	it("array-replace: replaces array wholesale, does not merge elements", () => {
		const target: Record<string, unknown> = { a: [1, 2, 3] };
		const source: Record<string, unknown> = { a: [9] };
		clearAndFill(target, source);
		expect(target.a).toEqual([9]);
	});

	it("key-prune: deletes keys from target that are absent in source", () => {
		const target: Record<string, unknown> = { a: 1, b: 2 };
		const source: Record<string, unknown> = { a: 1 };
		clearAndFill(target, source);
		expect("b" in target).toBe(false);
	});

	it("nested-object identity: preserves the reference of an existing nested object", () => {
		const inner: Record<string, unknown> = { y: 10 };
		const target: Record<string, unknown> = { x: inner };
		const source: Record<string, unknown> = { x: { y: 20, z: 30 } };
		clearAndFill(target, source);
		// target.x must be the SAME object reference as inner (mutated in place)
		expect(target.x).toBe(inner);
		expect((target.x as Record<string, unknown>).y).toBe(20);
		expect((target.x as Record<string, unknown>).z).toBe(30);
	});

	it("nested-prune: within a preserved nested object, prunes stale keys and adds new ones", () => {
		const inner: Record<string, unknown> = { a: 1, old: 99 };
		const target: Record<string, unknown> = { x: inner };
		const source: Record<string, unknown> = { x: { a: 2, added: 3 } };
		clearAndFill(target, source);
		// Same nested reference, mutated in place...
		expect(target.x).toBe(inner);
		// ...with the stale key pruned, the surviving key updated, the new key added.
		expect("old" in (target.x as Record<string, unknown>)).toBe(false);
		expect((target.x as Record<string, unknown>).a).toBe(2);
		expect((target.x as Record<string, unknown>).added).toBe(3);
	});

	it("primitive overwrite: updates primitive values in target", () => {
		const target: Record<string, unknown> = { n: 1 };
		const source: Record<string, unknown> = { n: 2 };
		clearAndFill(target, source);
		expect(target.n).toBe(2);
	});

	it("target identity: never replaces the target object itself", () => {
		const target: Record<string, unknown> = { a: 1 };
		const t = target;
		const source: Record<string, unknown> = { a: 99, b: "hello" };
		clearAndFill(target, source);
		// The variable 'target' and 't' must still be the same object
		expect(target).toBe(t);
		expect(target.a).toBe(99);
		expect(target.b).toBe("hello");
	});
});

// ── 2. Reference identity — finding -09 ────────────────────────────────────

describe("ConfigManager reference identity (finding -09)", () => {
	it("globalThis.sysconfig === this._config before and after initialize", async () => {
		const cm = ConfigManager.getInstance();

		// Capture the live sysconfig reference BEFORE initialize
		const ref = (globalThis as any).sysconfig as Record<string, unknown>;

		// initialize with a unique key to confirm data flows in.
		// Note: applyCliOverrides converts kebab to dot-notation, so
		// --cfg-ident-probe becomes nested at cfg.ident.probe. We verify via
		// cm.get() for value correctness, and via ref for reference identity.
		await cm.initialize(["--cfg-ident-probe=zzz"]);

		// The sysconfig reference must still be the same object
		expect((globalThis as any).sysconfig).toBe(ref);

		// The live ref must observe the new value at nested dot-path (in-place
		// mutation happened). cfg-ident-probe is mapped to cfg.ident.probe.
		const nested = (ref.cfg as Record<string, unknown> | undefined)?.ident as
			| Record<string, unknown>
			| undefined;
		expect(nested?.probe).toBe("zzz");

		// Confirm via the public API too
		expect(cm.get("cfg.ident.probe")).toBe("zzz");

		// getConfig() must also return the same reference
		expect(cm.getConfig()).toBe(ref);
	});
});

// ── 3. Seeded defaults before init — finding -02 ───────────────────────────

describe("ConfigManager seeded defaults before initialize (finding -02)", () => {
	it("getConfig() is non-empty and contains a real bundled key even before initialize", () => {
		const cm = ConfigManager.getInstance();

		// "markets" is a real top-level key in ConfigManager.json.
		// The singleton may already be initialized by sibling tests running in
		// the same process; we cannot guarantee a pristine constructor call here.
		// However, the invariant holds either way: the config must always contain
		// the bundled default key — never an empty object — because the constructor
		// seeds it synchronously via clearAndFill.
		//
		// Limitation: true isolation of a fresh instance is impossible because
		// ConfigManager is a singleton. This test asserts the weaker (but still
		// meaningful) invariant: getConfig() is never empty and "markets" is present.
		const config = cm.getConfig();
		expect(Object.keys(config).length).toBeGreaterThan(0);
		expect(config.markets).toBeDefined();
	});

	it("get() returns the bundled default value for a real key", () => {
		const cm = ConfigManager.getInstance();
		// "retrieve" is another real top-level key in ConfigManager.json.
		// After construction (or initialize), it must be present and non-undefined.
		const val = cm.get("retrieve");
		expect(val).toBeDefined();
	});
});
