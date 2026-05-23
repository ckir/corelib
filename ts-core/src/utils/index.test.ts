import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as utils from "./index";
import * as runtimeModule from "./runtime";

describe("Utils General Abstractions", () => {
	const originalProcess = globalThis.process;
	const originalDeno = (globalThis as any).Deno;

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		globalThis.process = originalProcess;
		(globalThis as any).Deno = originalDeno;
	});

	describe("getEnv", () => {
		it("should get env from process.env in Node", () => {
			(globalThis as any).Deno = undefined;
			process.env.TEST_VAR = "hello";
			expect(utils.getEnv("TEST_VAR")).toBe("hello");
		});

		it("should get env from Deno.env in Deno", () => {
			(globalThis as any).Deno = {
				env: {
					get: vi.fn().mockReturnValue("deno-val"),
				},
			};
			expect(utils.getEnv("TEST_VAR")).toBe("deno-val");
		});
	});

	describe("getAllEnv", () => {
		it("should get all env from process.env in Node", () => {
			(globalThis as any).Deno = undefined;
			const env = utils.getAllEnv();
			expect(env).toMatchObject(process.env);
		});

		it("should get all env from Deno.env in Deno", () => {
			const mockEnv = { FOO: "BAR" };
			(globalThis as any).Deno = {
				env: {
					toObject: vi.fn().mockReturnValue(mockEnv),
				},
			};
			expect(utils.getAllEnv()).toEqual(mockEnv);
		});
	});

	describe("getPlatform", () => {
		it("should detect windows from process.platform", () => {
			vi.spyOn(runtimeModule, "detectRuntime").mockReturnValue("node");
			(globalThis as any).Deno = undefined;
			Object.defineProperty(process, "platform", {
				value: "win32",
				configurable: true,
			});
			expect(utils.getPlatform()).toBe("windows");
		});

		it("should detect linux from process.platform", () => {
			vi.spyOn(runtimeModule, "detectRuntime").mockReturnValue("node");
			(globalThis as any).Deno = undefined;
			Object.defineProperty(process, "platform", {
				value: "linux",
				configurable: true,
			});
			expect(utils.getPlatform()).toBe("linux");
		});

		it("should detect platform in Deno", () => {
			vi.spyOn(runtimeModule, "detectRuntime").mockReturnValue("deno");
			(globalThis as any).Deno = {
				build: { os: "windows" },
			};
			expect(utils.getPlatform()).toBe("windows");

			(globalThis as any).Deno.build.os = "darwin";
			expect(utils.getPlatform()).toBe("linux"); // fallback to linux
		});
	});

	describe("getMode", () => {
		it("should return production when NODE_ENV is production", () => {
			process.env.NODE_ENV = "PRODUCTION";
			expect(utils.getMode()).toBe("production");
		});

		it("should return development otherwise", () => {
			process.env.NODE_ENV = "test";
			expect(utils.getMode()).toBe("development");

			delete process.env.NODE_ENV;
			expect(utils.getMode()).toBe("development");
		});
	});

	describe("sleep", () => {
		it("should wait for specified time", async () => {
			const start = Date.now();
			await utils.sleep(50);
			const end = Date.now();
			expect(end - start).toBeGreaterThanOrEqual(40);
		});
	});

	describe("getCwd", () => {
		it("should return process.cwd in Node", () => {
			(globalThis as any).Deno = undefined;
			expect(utils.getCwd()).toBe(process.cwd());
		});

		it("should return Deno.cwd in Deno", () => {
			(globalThis as any).Deno = {
				cwd: () => "/deno/cwd",
			};
			expect(utils.getCwd()).toBe("/deno/cwd");
		});
	});
});
