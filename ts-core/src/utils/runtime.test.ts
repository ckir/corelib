import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectRuntime } from "./runtime";

describe("detectRuntime", () => {
	const originalProcess = globalThis.process;

	beforeEach(() => {
		vi.resetModules();
		// Reset globals using stubGlobal
		vi.stubGlobal("Bun", undefined);
		vi.stubGlobal("Deno", undefined);
		vi.stubGlobal("caches", undefined);
		vi.stubGlobal("WebSocketPair", undefined);
		vi.stubGlobal("cloudflare", undefined);
		vi.stubGlobal("__CFW__", undefined);

		// Reset process.env
		if (globalThis.process) {
			globalThis.process.env = {};
		}
	});

	afterEach(() => {
		globalThis.process = originalProcess;
		vi.unstubAllGlobals();
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
		vi.stubGlobal("cloudflare", {});
		expect(detectRuntime()).toBe("cloudflare");
		vi.stubGlobal("cloudflare", undefined);

		vi.stubGlobal("caches", {});
		expect(detectRuntime()).toBe("cloudflare");
		vi.stubGlobal("caches", undefined);

		vi.stubGlobal("WebSocketPair", {});
		expect(detectRuntime()).toBe("cloudflare");
		vi.stubGlobal("WebSocketPair", undefined);

		vi.stubGlobal("__CFW__", {});
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
		vi.stubGlobal("Bun", {});
		expect(detectRuntime()).toBe("bun");
	});

	it("should detect deno from global Deno", () => {
		vi.stubGlobal("Deno", {
			version: {
				deno: "1.0.0",
			},
		});
		expect(detectRuntime()).toBe("deno");
	});

	it("should default to node", () => {
		expect(detectRuntime()).toBe("node");
	});
});
