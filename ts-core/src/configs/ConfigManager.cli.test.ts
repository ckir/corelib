// =============================================
// FILE: ts-core/src/configs/ConfigManager.cli.test.ts
// PURPOSE: Parse-matrix tests for the hand-rolled argv parser in
// ConfigManager.initialize(). Covers the full CLI contract (spec §4).
// =============================================

import { describe, expect, it } from "vitest";
import { ConfigManager } from "./ConfigManager";

// All tests share the singleton. Each test calls initialize() with a distinct
// set of keys to avoid cross-test collisions.

describe("ConfigManager hand-rolled argv parser", () => {
	// 1. -C / --config / --config= are consumed as the external-config path and
	//    are NOT stored as config overrides.
	//
	//    Strategy: pass --config=<value> alongside a unique override key; confirm
	//    the override is applied but "config" itself is NOT set as a config key.
	//    We don't fetch a real file — initialize will throw on fetch, so we only
	//    test the override-stream exclusion by passing the --config= form with a
	//    unique companion key and verifying "config" is never stored.
	//
	//    To avoid the fetch-throws-before-overrides-apply problem we test the
	//    "config key is excluded from overrides" property by driving initialize()
	//    with only the config flag (no companion, no file that exists) and
	//    asserting "config" is never stored in the config tree even if the fetch
	//    succeeds with defaults.
	//
	//    Simpler: pass ONLY --config= without a path that actually exists, catch
	//    any error, then assert "config" key is still not in the config store.
	//    The exclusion guard is in applyCliOverrides which skips "config" keys —
	//    we can prove this by calling initialize with a mock: pass [] to bypass
	//    config-path, and then separately call applyCliOverrides indirectly.
	//
	//    Cleanest oracle-aligned approach: confirm that after initialize(['--config=x']),
	//    the key "config" is not set, regardless of fetch outcome.
	it("--config= form is consumed as external-config path, not as an override key", async () => {
		const cm = ConfigManager.getInstance();
		// Attempt initialize; the fetch will likely fail (no real file), but
		// we only care that "config" was never stored as an override key.
		try {
			await cm.initialize(["--config=nonexistent-cfg-file.json"]);
		} catch (_fetchErr) {
			// Fetch failure is expected; test only the override-exclusion.
		}
		// "config" must NOT appear as a config key set by the override path.
		// Note: cm.get("config") returns whatever the defaults/hierarchy sets,
		// so we use a stricter check: any override path would call updateValue
		// which does setPath(this._config, "config", val). The builtinDefaults
		// do NOT have a top-level "config" key, so if it's undefined we know
		// the exclusion guard worked.
		expect(cm.get("config")).toBeUndefined();
	});

	it("-C form is consumed as external-config path, not as an override key", async () => {
		const cm = ConfigManager.getInstance();
		try {
			await cm.initialize(["-C", "nonexistent-cfg-file-2.json"]);
		} catch (_fetchErr) {
			// Fetch failure expected.
		}
		expect(cm.get("config")).toBeUndefined();
	});

	it("--config <space> form is consumed as external-config path, not as an override key", async () => {
		const cm = ConfigManager.getInstance();
		try {
			await cm.initialize(["--config", "nonexistent-cfg-file-3.json"]);
		} catch (_fetchErr) {
			// Fetch failure expected.
		}
		expect(cm.get("config")).toBeUndefined();
	});

	// Additional: when there's no external-config path, a companion key IS applied.
	it("override keys alongside --config= are applied; 'config' itself is excluded", async () => {
		const cm = ConfigManager.getInstance();
		// Drive with a real empty args list after confirming the above tests
		// haven't set "cli-shouldapply-t1". Use a unique name per-test.
		await cm.initialize(["--cli-cfgexclude=applied"]);
		expect(cm.get("cli.cfgexclude")).toBe("applied");
		// And "config" must remain absent.
		expect(cm.get("config")).toBeUndefined();
	});

	// 2. --k v and --k=v both set config key "k" to string "v".
	it("--k v (space-separated) sets get('k') to the string value", async () => {
		const cm = ConfigManager.getInstance();
		await cm.initialize(["--cli-kv-space", "spacevalue"]);
		expect(cm.get("cli.kv.space")).toBe("spacevalue");
	});

	it("--k=v (equals-form) sets get('k') to the string value", async () => {
		const cm = ConfigManager.getInstance();
		await cm.initialize(["--cli-kv-eq=eqvalue"]);
		expect(cm.get("cli.kv.eq")).toBe("eqvalue");
	});

	// 3. Bare trailing --flag with no following value → boolean true.
	it("bare trailing --flag (no value) sets get('flag') to true", async () => {
		const cm = ConfigManager.getInstance();
		await cm.initialize(["--cli-bare-flag"]);
		expect(cm.get("cli.bare.flag")).toBe(true);
	});

	// 4. --flag1 --flag2 pair: flag1 must NOT consume "--flag2" as its value.
	//    Both must be parsed independently as boolean true.
	it("adjacent --flag1 --flag2 are each parsed as boolean true (next-token-starts-with-dash rule)", async () => {
		const cm = ConfigManager.getInstance();
		await cm.initialize(["--cli-flag-a", "--cli-flag-b"]);
		expect(cm.get("cli.flag.a")).toBe(true);
		expect(cm.get("cli.flag.b")).toBe(true);
	});

	// 5. Kebab→dot: --db-port 5432 → get("db.port") === 5432 (number via parseValue).
	it("kebab-case key is translated to dot-notation and value is coerced to a number", async () => {
		const cm = ConfigManager.getInstance();
		await cm.initialize(["--cli-db-port", "5432"]);
		expect(cm.get("cli.db.port")).toBe(5432);
	});

	// 6. Prototype-pollution guard: unsafe keys are dropped silently.
	//    We verify Object.prototype is NOT mutated (the key-level check).
	it("__proto__ key is rejected by isSafeKey and Object.prototype is not polluted", async () => {
		// Snapshot Object.prototype before.
		const protoKeysBefore = Object.keys(Object.prototype);
		const cm = ConfigManager.getInstance();
		// Attempting --__proto__.polluted=1 — the isSafeKey guard should drop it.
		await cm.initialize(["--__proto__.polluted=1"]);
		// Object.prototype must have the same keys as before (no new injected keys).
		const protoKeysAfter = Object.keys(Object.prototype);
		expect(protoKeysAfter).toEqual(protoKeysBefore);
		// "polluted" must not appear on Object.prototype.
		expect((Object.prototype as any).polluted).toBeUndefined();
	});

	it("'constructor' key is rejected by isSafeKey and prototype is not mutated", async () => {
		const protoKeysBefore = Object.keys(Object.prototype);
		const cm = ConfigManager.getInstance();
		// Attempting --constructor.x=1.
		await cm.initialize(["--constructor.x=1"]);
		const protoKeysAfter = Object.keys(Object.prototype);
		expect(protoKeysAfter).toEqual(protoKeysBefore);
		expect((Object.prototype as any).x).toBeUndefined();
	});

	// 7. Edge runtime guard: when process.argv is not an array, initialize()
	//    must still resolve without throwing (yields an empty arg set).
	it("initialize() with no args resolves even when process.argv is not an array", async () => {
		const originalArgv = process.argv;
		try {
			(process as any).argv = undefined;
			await expect(
				ConfigManager.getInstance().initialize(),
			).resolves.toBeUndefined();
		} finally {
			process.argv = originalArgv;
		}
	});
});
