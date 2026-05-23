import { beforeEach, describe, expect, it, vi } from "vitest";
import logger from "./browser";

describe("BrowserLogger", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		// Default level is info
		logger.level = "info";
	});

	it("should map levels to console functions", () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		logger.level = "trace";

		logger.trace("trace msg");
		expect(debugSpy).toHaveBeenCalledWith("[TRACE]", "trace msg", {});

		logger.debug("debug msg");
		expect(debugSpy).toHaveBeenCalledWith("[DEBUG]", "debug msg", {});

		logger.info("info msg");
		expect(infoSpy).toHaveBeenCalledWith("[INFO]", "info msg", {});

		logger.warn("warn msg");
		expect(warnSpy).toHaveBeenCalledWith("[WARN]", "warn msg", {});

		logger.error("error msg");
		expect(errorSpy).toHaveBeenCalledWith("[ERROR]", "error msg", {});

		logger.fatal("fatal msg");
		expect(errorSpy).toHaveBeenCalledWith("[FATAL]", "fatal msg", {});
	});

	it("should respect log level", () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

		logger.level = "warn";
		logger.info("should not show");
		expect(infoSpy).not.toHaveBeenCalled();

		logger.level = "info";
		logger.info("should show");
		expect(infoSpy).toHaveBeenCalled();
	});

	it("should support child loggers with context", () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		const child = logger.child({ module: "test" });

		child.info("hello");
		expect(infoSpy).toHaveBeenCalledWith("[INFO]", "hello", { module: "test" });
	});

	it("should share level state between parent and child", () => {
		const child = logger.child({ module: "test" });

		logger.level = "error";
		expect(child.level).toBe("error");

		child.level = "debug";
		expect(logger.level).toBe("debug");
	});

	it("should support silent()", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		logger.silent();
		expect(logger.level).toBe("silent");
		logger.error("nothing");
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
