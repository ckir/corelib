import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeDetector from "./runtime";
import { getSysInfo } from "./SysInfo";

// Mock detectRuntime
vi.mock("./runtime", () => ({
	detectRuntime: vi.fn(),
}));

describe("SysInfo", () => {
	const originalProcess = globalThis.process;
	const originalDeno = (globalThis as any).Deno;

	beforeEach(() => {
		vi.resetAllMocks();
		if (globalThis.process) {
			// Mock process methods if needed
			vi.spyOn(process, "cwd").mockReturnValue("/mock/cwd");
			vi.spyOn(process, "uptime").mockReturnValue(12345);
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		globalThis.process = originalProcess;
		(globalThis as any).Deno = originalDeno;
	});

	it("should redact sensitive environment variables", () => {
		// Since redactEnv is not exported, we test it via getSysInfo
		// or we can test it indirectly by checking the 'env' property of getSysInfo()

		(runtimeDetector.detectRuntime as any).mockReturnValue("node");

		const originalEnv = process.env;
		process.env = {
			NODE_ENV: "test",
			MY_API_KEY: "secret-value",
			DATABASE_PASSWORD: "password123",
			PUBLIC_VAR: "public",
		};

		const info = getSysInfo();
		expect(info.env.NODE_ENV).toBe("test");
		expect(info.env.MY_API_KEY).toBe("[REDACTED]");
		expect(info.env.DATABASE_PASSWORD).toBe("[REDACTED]");
		expect(info.env.PUBLIC_VAR).toBe("public");

		process.env = originalEnv;
	});

	it("should collect info for node/bun runtime", () => {
		(runtimeDetector.detectRuntime as any).mockReturnValue("node");

		const info = getSysInfo();
		expect(info.runtime).toBe("node");
		expect(info.os).toBe(process.platform);
		expect(info.arch).toBe(process.arch);
		expect(info.cwd).toBe("/mock/cwd");
		expect(info.uptime).toBe(12345);
		expect(info.memory).toHaveProperty("rss");
	});

	it("should collect info for deno runtime", () => {
		(runtimeDetector.detectRuntime as any).mockReturnValue("deno");

		(globalThis as any).Deno = {
			build: { os: "darwin", arch: "aarch64" },
			pid: 123,
			ppid: 1,
			cwd: () => "/deno/cwd",
			osRelease: () => "20.0.0",
			loadavg: () => [1, 2, 3],
			systemMemoryInfo: () => ({ total: 16000000 }),
			env: { toObject: () => ({ RUNTIME: "deno" }) },
		};

		const info = getSysInfo();
		expect(info.runtime).toBe("deno");
		expect(info.os).toBe("darwin");
		expect(info.arch).toBe("aarch64");
		expect(info.cwd).toBe("/deno/cwd");
		expect(info.osVersion).toBe("20.0.0");
		expect(info.memory.rss).toBe(16000000);
	});

	it("should return fallback for unknown runtime", () => {
		(runtimeDetector.detectRuntime as any).mockReturnValue("unknown");

		const info = getSysInfo();
		expect(info.runtime).toBe("unknown");
		expect(info.os).toBe("unknown");
	});
});
