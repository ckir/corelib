import { describe, expect, it, vi } from "vitest";
import { createRouter } from "./router";

describe("Router", () => {
	it("should return 200 for /health", async () => {
		const app = createRouter();
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	it("should return 200 for /api/v1/health", async () => {
		const app = createRouter();
		const res = await app.request("/api/v1/health");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
		expect(body.version).toBe("v1");
	});

	it("should return 200 and emit logs for /api/v1/tests/logger", async () => {
		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			child: vi.fn().mockReturnThis(),
			bindings: vi.fn().mockReturnValue({}),
		};

		const app = createRouter(logger as any);
		const res = await app.request("/api/v1/tests/logger");

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("success");
		expect(body.message).toBe("Logs emitted");

		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("Information level"),
			expect.any(Object),
		);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("Warning level"),
			expect.any(Object),
		);
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("Error level"),
			expect.any(Object),
		);
	});

	it("should return 404 for unknown routes", async () => {
		const app = createRouter();
		const res = await app.request("/unknown");
		expect(res.status).toBe(404);
	});
});
