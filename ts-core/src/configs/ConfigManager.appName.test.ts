// =============================================
// FILE: ts-core/src/configs/ConfigManager.appName.test.ts
// PURPOSE: Unit tests for monorepo-aware app-name resolution (resolveAppName).
// =============================================

import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAppName } from "./ConfigManager";

/**
 * Run resolveAppName over a virtual filesystem. Paths use POSIX semantics so
 * the test is deterministic on every OS (we inject nodePath.posix).
 */
function appNameOver(cwd: string, files: Map<string, string | true>): string {
	const exists = (p: string) => files.has(p);
	const read = (p: string) => {
		const v = files.get(p);
		if (typeof v !== "string") throw new Error(`not a readable file: ${p}`);
		return v;
	};
	return resolveAppName(cwd, nodePath.posix, exists, read);
}

describe("resolveAppName (monorepo-aware app identity)", () => {
	it("returns the monorepo root folder name when a pnpm-workspace.yaml is above cwd", () => {
		const files = new Map<string, string | true>([
			["/repo/pnpm-workspace.yaml", true],
		]);
		expect(appNameOver("/repo/packages/core", files)).toBe("repo");
	});

	it("returns the root folder name when a package.json with a workspaces field is above cwd", () => {
		const files = new Map<string, string | true>([
			["/home/x/myrepo/package.json", '{"workspaces":["packages/*"]}'],
		]);
		expect(appNameOver("/home/x/myrepo/packages/web", files)).toBe("myrepo");
	});

	it("falls back to basename(cwd) when there is no workspace marker (standalone app)", () => {
		expect(appNameOver("/srv/app/sub", new Map())).toBe("sub");
	});

	it("resolves immediately when cwd itself is the monorepo root", () => {
		const files = new Map<string, string | true>([
			["/repo/pnpm-workspace.yaml", true],
		]);
		expect(appNameOver("/repo", files)).toBe("repo");
	});

	it("ignores a leaf package.json without a workspaces field and keeps walking up", () => {
		const files = new Map<string, string | true>([
			["/repo/packages/core/package.json", '{"name":"@scope/core"}'],
			["/repo/pnpm-workspace.yaml", true],
		]);
		expect(appNameOver("/repo/packages/core", files)).toBe("repo");
	});

	it("skips a malformed package.json and keeps walking up to the workspace root", () => {
		const files = new Map<string, string | true>([
			["/repo/packages/core/package.json", "{ this is : not json"],
			["/repo/pnpm-workspace.yaml", true],
		]);
		expect(appNameOver("/repo/packages/core", files)).toBe("repo");
	});

	it("treats an empty workspaces array as a monorepo boundary", () => {
		const files = new Map<string, string | true>([
			["/repo/package.json", '{"workspaces":[]}'],
		]);
		expect(appNameOver("/repo/apps/api", files)).toBe("repo");
	});
});
