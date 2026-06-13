// =============================================
// FILE: ts-core/src/configs/ConfigManager.concurrency.test.ts
// PURPOSE: Verify Epic-1 Task 4 concurrency invariants: single-flight init (-01),
// failure eviction + self-heal, sync→async clobber survival (-05), readiness API,
// and premature-read warning.
// =============================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "./ConfigManager";

describe("ConfigManager — concurrency layer (Epic-1 Task 4)", () => {
	const cm = ConfigManager.getInstance();

	beforeEach(() => {
		cm.__resetForTests();
	});

	// ── 1. Single-flight idempotency ──────────────────────────────────────────

	it("concurrent initialize() calls share one in-flight promise (single-flight)", async () => {
		const p1 = cm.initialize(["--sf-a=1"]);
		const p2 = cm.initialize(["--sf-b=2"]);
		expect(p1).toBe(p2); // same promise object → only one sequence runs
		await Promise.all([p1, p2]);
		expect(cm.isInitialized).toBe(true);
		// The single run used the FIRST call's args; second call did not start a build.
		expect(cm.get("sf.a")).toBe(1);
		expect(cm.get("sf.b")).toBeUndefined();
	});

	// ── 2. Failed-init eviction + self-heal ───────────────────────────────────

	it("a failed initialize() is evicted so a later initialize() can succeed", async () => {
		// Mock fetchExternalConfig to reject once, simulating a bad -C path.
		const spy = vi
			.spyOn(ConfigManager.prototype as any, "fetchExternalConfig")
			.mockRejectedValueOnce(new Error("boom"));
		try {
			await expect(
				cm.initialize(["-C", "x.json"]),
			).rejects.toBeDefined();
		} finally {
			spy.mockRestore();
		}
		expect(cm.isInitialized).toBe(false);
		// Self-heal: a clean initialize now succeeds.
		await expect(cm.initialize([])).resolves.toBeUndefined();
		expect(cm.isInitialized).toBe(true);
	});

	// ── 3. Sync→async clobber survival ────────────────────────────────────────

	it("a synchronous updateValue during an in-flight build survives the staged swap", async () => {
		const spy = vi
			.spyOn(ConfigManager.prototype as any, "fetchExternalConfig")
			.mockImplementation(async () => {
				// We are mid-runInitSequence, AFTER _inFlightTempConfig was published.
				// A synchronous updateValue here must dual-write into the staging object
				// and therefore survive the final clearAndFill commit.
				cm.updateValue("clobber.survived", "yes");
				return {} as Record<string, unknown>;
			});
		try {
			await cm.initialize(["-C", "dummy-path.json"]);
		} finally {
			spy.mockRestore();
		}
		expect(cm.get("clobber.survived")).toBe("yes");
	});

	// ── 4. Readiness API ──────────────────────────────────────────────────────

	it("isInitialized flips after initialize(); whenReady resolves", async () => {
		expect(cm.isInitialized).toBe(false);
		const ready = cm.whenReady(); // returns the in-flight promise once init starts
		const init = cm.initialize([]);
		await init;
		expect(cm.isInitialized).toBe(true);
		await expect(cm.whenReady()).resolves.toBeUndefined();
		await ready; // must not hang/reject
	});

	// ── 5. Premature-read warning ─────────────────────────────────────────────

	it("warns in non-production when get() is called before initialize() resolves", async () => {
		// Ensure isInitialized is false (reset done in beforeEach).
		const warnSpy = vi.spyOn(
			(ConfigManager as any)._logger,
			"warn",
		);

		const originalNodeEnv = process.env.NODE_ENV;
		try {
			process.env.NODE_ENV = "development";
			// get() before initialize() → should warn AND still return a value.
			const value = cm.get("markets");
			expect(warnSpy).toHaveBeenCalled();
			const warnMsg = warnSpy.mock.calls[0][0] as string;
			expect(warnMsg).toContain("before initialize() resolved");
			// The seeded default for "markets" must be defined (it's in ConfigManager.json).
			expect(value).toBeDefined();
		} finally {
			process.env.NODE_ENV = originalNodeEnv;
			warnSpy.mockRestore();
		}
	});

	it("does NOT warn in production when get() is called before initialize() resolves", async () => {
		const warnSpy = vi.spyOn(
			(ConfigManager as any)._logger,
			"warn",
		);

		const originalNodeEnv = process.env.NODE_ENV;
		try {
			process.env.NODE_ENV = "production";
			const value = cm.get("markets");
			// Warn must NOT be triggered in production.
			const prematureWarnCalls = warnSpy.mock.calls.filter(
				(call) =>
					typeof call[0] === "string" &&
					(call[0] as string).includes("before initialize() resolved"),
			);
			expect(prematureWarnCalls).toHaveLength(0);
			// Value is still returned even without warning.
			expect(value).toBeDefined();
		} finally {
			process.env.NODE_ENV = originalNodeEnv;
			warnSpy.mockRestore();
		}
	});
});
