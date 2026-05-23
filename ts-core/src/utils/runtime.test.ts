import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectRuntime } from "./runtime";

describe("detectRuntime", () => {
	const originalProcess = globalThis.process;
	const originalBun = (globalThis as any).Bun;
	const originalDeno = (globalThis as any).Deno;
	const originalCaches = (globalThis as any).caches;
	const originalWebSocketPair = (globalThis as any).WebSocketPair;

	beforeEach(() => {
		vi.resetModules();
		// Reset globals
		delete (globalThis as any).Bun;
		delete (globalThis as any).Deno;
		delete (globalThis as any).caches;
		delete (globalThis as any).WebSocketPair;
		delete (globalThis as any).cloudflare;
		delete (globalThis as any).__CFW__;

		// Reset process.env
		if (globalThis.process) {
			globalThis.process.env = {};
		}
	});

	afterEach(() => {
		globalThis.process = originalProcess;
		(globalThis as any).Bun = originalBun;
		(globalThis as any).Deno = originalDeno;
		(globalThis as any).caches = originalCaches;
		(globalThis as any).WebSocketPair = originalWebSocketPair;
	});

	it("should detect runtime from process.env.RUNTIME", () => {
		process.env.RUNTIME = "bun";
		expect(detectRuntime()).toBe("bun");

		process.env.RUNTIME = "DENO";
		expect(detectRuntime()).toBe("deno");

		process.env.RUNTIME = "cloudflare";
		expect(detectRuntime()).toBe("cloudflare");
	});

	it("should ignore invalid RUNTIME environment variable", () => {
		process.env.RUNTIME = "invalid-runtime";
		expect(detectRuntime()).toBe("node"); // Default to node
	});

	it("should detect cloudflare from globals", () => {
		(globalThis as any).cloudflare = {};
		expect(detectRuntime()).toBe("cloudflare");
		(globalThis as any).cloudflare = undefined;

		(globalThis as any).caches = {};
		expect(detectRuntime()).toBe("cloudflare");
		(globalThis as any).caches = undefined;

		(globalThis as any).WebSocketPair = {};
		expect(detectRuntime()).toBe("cloudflare");
		(globalThis as any).WebSocketPair = undefined;

		(globalThis as any).__CFW__ = {};
		expect(detectRuntime()).toBe("cloudflare");
	});

	it("should detect cloudflare from process.env.PLATFORM", () => {
		process.env.PLATFORM = "cloudflare";
		expect(detectRuntime()).toBe("cloudflare");
	});

	it("should detect aws-lambda from environment variables", () => {
		process.env.AWS_LAMBDA_FUNCTION_NAME = "my-function";
		expect(detectRuntime()).toBe("aws-lambda");
	});

	it("should detect gcp-cloudrun from environment variables", () => {
		process.env.K_SERVICE = "my-service";
		expect(detectRuntime()).toBe("gcp-cloudrun");
		delete process.env.K_SERVICE;

		process.env.K_REVISION = "my-revision";
		expect(detectRuntime()).toBe("gcp-cloudrun");
		delete process.env.K_REVISION;

		process.env.GOOGLE_CLOUD_PROJECT = "my-project";
		expect(detectRuntime()).toBe("gcp-cloudrun");
	});

	it("should detect bun from global Bun", () => {
		(globalThis as any).Bun = {};
		expect(detectRuntime()).toBe("bun");
	});

	it("should detect deno from global Deno", () => {
		(globalThis as any).Deno = {
			version: {
				deno: "1.0.0",
			},
		};
		expect(detectRuntime()).toBe("deno");
	});

	it("should default to node", () => {
		expect(detectRuntime()).toBe("node");
	});
});
