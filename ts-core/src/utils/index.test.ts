import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as utils from "./index";
import * as runtimeModule from "./runtime";

describe("Utils General Abstractions", () => {
	const originalProcess = globalThis.process;

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		globalThis.process = originalProcess;
		vi.unstubAllGlobals();
	});

	describe("getEnv", () => {
		it("should get env from process.env in Node", () => {
			vi.stubGlobal("Deno", undefined);
			vi.stubGlobal("process", { env: { TEST_VAR: "hello" } });
			expect(utils.getEnv("TEST_VAR")).toBe("hello");
		});

		it("should get env from Deno.env in Deno", () => {
			vi.stubGlobal("Deno", {
				env: {
					get: vi.fn().mockReturnValue("deno-val"),
				},
			});
			expect(utils.getEnv("TEST_VAR")).toBe("deno-val");
		});
	});

	describe("getAllEnv", () => {
		it("should get all env from process.env in Node", () => {
			vi.stubGlobal("Deno", undefined);
			const mockEnv = { TEST_VAR: "hello" };
			vi.stubGlobal("process", { env: mockEnv });
			const env = utils.getAllEnv();
			expect(env).toMatchObject(mockEnv);
		});

		it("should get all env from Deno.env in Deno", () => {
			const mockEnv = { FOO: "BAR" };
			vi.stubGlobal("Deno", {
				env: {
					toObject: vi.fn().mockReturnValue(mockEnv),
				},
			});
			expect(utils.getAllEnv()).toEqual(mockEnv);
		});
	});

	describe("getPlatform", () => {
		it("should detect windows from process.platform", () => {
			vi.spyOn(runtimeModule, "detectRuntime").mockReturnValue("node");
			vi.stubGlobal("Deno", undefined);
			vi.stubGlobal("process", { platform: "win32" });
			expect(utils.getPlatform()).toBe("windows");
		});

		it("should detect linux from process.platform", () => {
			vi.spyOn(runtimeModule, "detectRuntime").mockReturnValue("node");
			vi.stubGlobal("Deno", undefined);
			vi.stubGlobal("process", { platform: "linux" });
			expect(utils.getPlatform()).toBe("linux");
		});

		it("should detect platform in Deno", () => {
			vi.spyOn(runtimeModule, "detectRuntime").mockReturnValue("deno");
			vi.stubGlobal("Deno", {
				build: { os: "windows" },
			});
			expect(utils.getPlatform()).toBe("windows");

			vi.stubGlobal("Deno", {
				build: { os: "darwin" },
			});
			expect(utils.getPlatform()).toBe("linux"); // fallback to linux
		});
	});

	describe("getMode", () => {
		it("should return production when NODE_ENV is production", () => {
			if (typeof process !== "undefined" && process.env) {
				const original = process.env.NODE_ENV;
				process.env.NODE_ENV = "PRODUCTION";
				expect(utils.getMode()).toBe("production");
				process.env.NODE_ENV = original;
			}
		});

		it("should return development otherwise", () => {
			if (typeof process !== "undefined" && process.env) {
				const original = process.env.NODE_ENV;
				process.env.NODE_ENV = "test";
				expect(utils.getMode()).toBe("development");
				
				delete process.env.NODE_ENV;
				expect(utils.getMode()).toBe("development");
				process.env.NODE_ENV = original;
			}
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
			vi.stubGlobal("Deno", undefined);
			if (typeof process !== "undefined") {
				expect(utils.getCwd()).toBe(process.cwd());
			}
		});

		it("should return Deno.cwd in Deno", () => {
			vi.stubGlobal("Deno", {
				cwd: () => "/deno/cwd",
			});
			expect(utils.getCwd()).toBe("/deno/cwd");
		});
	});
});
