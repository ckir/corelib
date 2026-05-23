import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEdgeLogger } from "./logger";

describe("createEdgeLogger", () => {
	let consoleSpy: any;

	beforeEach(() => {
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
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

	it("should have a silent method that does nothing", () => {
		const logger = createEdgeLogger();
		expect(() => logger.silent()).not.toThrow();
	});

	it("should have a flush method that calls the callback", () => {
		const logger = createEdgeLogger();
		const callback = vi.fn();
		logger.flush(callback);
		expect(callback).toHaveBeenCalled();
	});
});
