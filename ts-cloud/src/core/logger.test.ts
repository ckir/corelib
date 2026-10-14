import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEdgeLogger } from "./logger";

describe("createEdgeLogger", () => {
	let consoleSpy: any;

	beforeEach(() => {
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		consoleSpy.mockRestore();
	});

	it("should log messages in JSON format", () => {
		const logger = createEdgeLogger({ service: "test" });
		logger.info("Hello World", { foo: "bar" });

		expect(consoleSpy).toHaveBeenCalled();
		const logOutput = JSON.parse(consoleSpy.mock.calls[0][0]);

		expect(logOutput).toMatchObject({
			level: "info",
			msg: "Hello World",
			service: "test",
			extras: { foo: "bar" },
		});
		expect(logOutput.time).toBeDefined();
	});

	it("should support different log levels", () => {
		vi.stubEnv("LOG_LEVEL", "trace");
		const logger = createEdgeLogger();
		const levels = [
			"trace",
			"debug",
			"info",
			"warn",
			"error",
			"fatal",
		] as const;

		levels.forEach((level, index) => {
			logger[level](`${level} message`);
			const logOutput = JSON.parse(consoleSpy.mock.calls[index][0]);
			expect(logOutput.level).toBe(level);
			expect(logOutput.msg).toBe(`${level} message`);
		});
	});

	it("should create child loggers with merged bindings", () => {
		const parent = createEdgeLogger({ parentId: 1 });
		const child = parent.child({ childId: 2 });

		child.info("Child log");

		const logOutput = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(logOutput.parentId).toBe(1);
		expect(logOutput.childId).toBe(2);
		expect(logOutput.msg).toBe("Child log");
	});

	it("should return bindings via bindings() method", () => {
		const bindings = { a: 1, b: 2 };
		const logger = createEdgeLogger(bindings);
		expect(logger.bindings()).toEqual(bindings);
	});

	it("should drop everything after silent()", () => {
		const logger = createEdgeLogger();
		logger.silent();
		logger.fatal("nope");
		expect(consoleSpy).not.toHaveBeenCalled();
		expect(logger.level).toBe("silent");
	});

	it("honours LOG_LEVEL=warn: info/debug emit nothing, warn emits", () => {
		vi.stubEnv("LOG_LEVEL", "warn");
		const logger = createEdgeLogger();
		logger.debug("d");
		logger.info("i");
		expect(consoleSpy).not.toHaveBeenCalled();
		logger.warn("w");
		expect(consoleSpy).toHaveBeenCalledTimes(1);
		expect(logger.level).toBe("warn");
	});

	it("defaults to info (drops trace/debug) and ignores unknown LOG_LEVEL", () => {
		vi.stubEnv("LOG_LEVEL", "bogus");
		const logger = createEdgeLogger();
		logger.trace("t");
		logger.debug("d");
		expect(consoleSpy).not.toHaveBeenCalled();
		logger.info("i");
		expect(consoleSpy).toHaveBeenCalledTimes(1);
	});

	it("children inherit the parent level", () => {
		vi.stubEnv("LOG_LEVEL", "error");
		const child = createEdgeLogger().child({ a: 1 });
		child.warn("w");
		expect(consoleSpy).not.toHaveBeenCalled();
	});

	it("setTelemetry('on') adds telemetry; invalid mode throws", () => {
		const logger = createEdgeLogger();
		logger.setTelemetry("on");
		logger.info("t");
		expect(JSON.parse(consoleSpy.mock.calls[0][0]).telemetry).toBeDefined();
		expect(() => logger.setTelemetry("x" as never)).toThrow();
	});

	it("should have a flush method that calls the callback", () => {
		const logger = createEdgeLogger();
		const callback = vi.fn();
		logger.flush(callback);
		expect(callback).toHaveBeenCalled();
	});
});

describe("createEdgeLogger error serialization", () => {
	const logged = (spy: { mock: { calls: unknown[][] } }) =>
		JSON.parse(String(spy.mock.calls.at(-1)?.[0])) as {
			extras: { error: { message?: string; name?: string; stack?: string } };
		};

	it("keeps message, name and stack of an Error passed in extras", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		createEdgeLogger().error("failed", { error: new Error("boom") });
		const { extras } = logged(spy);
		expect(extras.error.message).toBe("boom");
		expect(extras.error.name).toBe("Error");
		expect(extras.error.stack).toContain("boom");
		spy.mockRestore();
	});

	it("does not throw on a self-referencing Error and still logs its message", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const e = new Error("circular") as Error & { self?: unknown };
		e.self = e;
		expect(() =>
			createEdgeLogger().error("failed", { error: e }),
		).not.toThrow();
		expect(logged(spy).extras.error.message).toBe("circular");
		spy.mockRestore();
	});
});
