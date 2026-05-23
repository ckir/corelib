import { Cron } from "croner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { includeExcludeCron } from "./cron";

vi.mock("croner", () => {
	return {
		Cron: vi.fn(),
	};
});

describe("includeExcludeCron", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("should call the handler when include matches and no exclude match", () => {
		const handler = vi.fn();

		// Mock Cron instances
		const includeCronMock = {
			nextRun: vi.fn().mockReturnValue(null), // matches now
		};
		const excludeCronMock = {
			nextRun: vi.fn().mockReturnValue(new Date()), // does not match now
		};

		// The first call to Cron constructor is for the main job "* * * * * *"
		// Subsequent calls are for include/exclude rules
		(Cron as any).mockImplementation((pattern: string) => {
			if (pattern === "* * * * * *") {
				return {
					// This is the main job
				};
			}
			if (pattern === "0 * * * * *") {
				return includeCronMock;
			}
			if (pattern === "30 * * * * *") {
				return excludeCronMock;
			}
		});

		// We need to trigger the main job's callback
		let jobCallback: () => void = () => {};
		(Cron as any).mockImplementation(function (
			this: any,
			pattern: string,
			cb: () => void,
		) {
			if (pattern === "* * * * * *") {
				jobCallback = cb;
				return {};
			}
			if (pattern === "0 * * * * *") return includeCronMock;
			if (pattern === "30 * * * * *") return excludeCronMock;
		});

		includeExcludeCron(["0 * * * * *"], ["30 * * * * *"], handler);

		// Trigger the job
		jobCallback();

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("should NOT call the handler when include does NOT match", () => {
		const handler = vi.fn();

		const includeCronMock = {
			nextRun: vi.fn().mockReturnValue(new Date()), // no match
		};

		let jobCallback: () => void = () => {};
		(Cron as any).mockImplementation(function (
			this: any,
			pattern: string,
			cb: () => void,
		) {
			if (pattern === "* * * * * *") {
				jobCallback = cb;
				return {};
			}
			return includeCronMock;
		});

		includeExcludeCron(["0 * * * * *"], [], handler);
		jobCallback();

		expect(handler).not.toHaveBeenCalled();
	});

	it("should NOT call the handler when exclude matches", () => {
		const handler = vi.fn();

		const includeCronMock = {
			nextRun: vi.fn().mockReturnValue(null), // matches
		};
		const excludeCronMock = {
			nextRun: vi.fn().mockReturnValue(null), // matches (should block)
		};

		let jobCallback: () => void = () => {};
		(Cron as any).mockImplementation(function (
			this: any,
			pattern: string,
			cb: () => void,
		) {
			if (pattern === "* * * * * *") {
				jobCallback = cb;
				return {};
			}
			if (pattern === "include") return includeCronMock;
			if (pattern === "exclude") return excludeCronMock;
		});

		includeExcludeCron(["include"], ["exclude"], handler);
		jobCallback();

		expect(handler).not.toHaveBeenCalled();
	});

	it("should pass timezone to Cron instances", () => {
		const handler = vi.fn();
		const timezone = "America/New_York";

		let jobCallback: () => void = () => {};
		(Cron as any).mockImplementation(function (
			this: any,
			pattern: string,
			cb: () => void,
		) {
			if (pattern === "* * * * * *") {
				jobCallback = cb;
				return {};
			}
			return { nextRun: () => null };
		});

		includeExcludeCron(["include"], [], handler, timezone);

		// Trigger the main job to instantiate the include cron
		jobCallback();

		// Find the call for the include cron (not the main job)
		const cronCalls = (Cron as any).mock.calls;
		// main job + include cron = 2 calls
		expect(cronCalls.length).toBeGreaterThanOrEqual(2);

		const includeCall = cronCalls.find((call: any) => call[0] === "include");
		expect(includeCall[1]).toEqual({ timezone });
	});
});
