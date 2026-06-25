import { describe, expect, it, vi } from "vitest";
import { StrictLoggerWrapper } from "./common";
import browserLogger from "./implementations/browser";
import createCloudflareLogger from "./implementations/cloudflare";

describe("logger extras error serialization (wiring)", () => {
	it("Pino StrictLoggerWrapper serializes an Error in extras", () => {
		const calls: any[] = [];
		// minimal fake pino: only the .error sink is exercised here
		const fakePino: any = { error: (obj: unknown) => calls.push(obj) };
		const log = new StrictLoggerWrapper(fakePino);

		log.error("boom", { err: new Error("kaboom") });

		expect(calls).toHaveLength(1);
		expect(calls[0].err).toMatchObject({ message: "kaboom" });
		expect(typeof calls[0].err.stack).toBe("string");
	});

	it("CloudflareLogger serializes an Error in extras", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const log = createCloudflareLogger();

		log.error("boom", { err: new Error("kaboom") });

		const payload = JSON.parse(spy.mock.calls[0][0] as string);
		expect(payload.err).toMatchObject({ message: "kaboom" });
		spy.mockRestore();
	});

	it("BrowserLogger serializes an Error in extras", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		browserLogger.error("boom", { err: new Error("kaboom") });

		// emit -> consoleFn(`[ERROR]`, msg, { ...ctx, ...normalizeExtras(extras) })
		const merged = spy.mock.calls[0][2] as any;
		expect(merged.err).toMatchObject({ message: "kaboom" });
		spy.mockRestore();
	});
});
