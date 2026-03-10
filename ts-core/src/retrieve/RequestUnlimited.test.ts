// =============================================
// FILE: ts-core/src/retrieve/RequestUnlimited.test.ts
// PURPOSE: Comprehensive test suite for RequestUnlimited.
// Covers: Single/Parallel requests, Retries (429, 5xx), Custom Headers/Hooks, Error Serialization, and Timeouts.
// Uses MSW for network mocking and Vitest for assertions.
// =============================================

import { delay, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { StrictLogger } from "../loggers/common";
import { endPoint, endPoints, RequestUnlimited } from "./RequestUnlimited";

// State for the retry mock so it can be reset between tests
let retryCountState = 0;

/**
 * MSW Server Setup to mock network behavior
 */
const handlers = [
	// Standard Success JSON
	http.get("https://api.test.com/success", () => {
		return HttpResponse.json({ foo: "bar" });
	}),

	// Plain Text Success
	http.get("https://api.test.com/text", () => {
		return new HttpResponse("plain text", {
			headers: { "Content-Type": "text/plain" },
		});
	}),

	// 404 Error (Should return status: 'error' but not throw)
	http.get("https://api.test.com/404", () => {
		return new HttpResponse(null, { status: 404 });
	}),

	// 500 Error (Internal Server Error) - Should be retried by default
	http.get("https://api.test.com/500", () => {
		retryCountState++;
		if (retryCountState < 2) return new HttpResponse(null, { status: 500 });
		return HttpResponse.json({ recovered: true });
	}),

	// Rate Limit (429) - Stateful mock to test retries
	http.get("https://api.test.com/retry-logic", () => {
		retryCountState++;
		if (retryCountState < 3) return new HttpResponse(null, { status: 429 });
		return HttpResponse.json({ attempts: retryCountState });
	}),

	// Timeout Simulation
	http.get("https://api.test.com/timeout", async () => {
		await delay(1000);
		return HttpResponse.json({ done: true });
	}),

	// POST request test
	http.post("https://api.test.com/post", async ({ request }) => {
		const body = await request.json();
		return HttpResponse.json({ received: body }, { status: 201 });
	}),
];

const server = setupServer(...handlers);

describe("RequestUnlimited", () => {
	beforeAll(() => {
		server.listen({ onUnhandledRequest: "error" });

		// Mock global logger with the new strict API
		globalThis.logger = {
			trace: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			fatal: vi.fn(),
			child: vi.fn().mockReturnThis(),
			setTelemetry: vi.fn(),
			level: "info",
			levelVal: 30,
			bindings: vi.fn().mockReturnValue({}),
			silent: vi.fn(),
		} as unknown as StrictLogger;
	});

	afterAll(() => server.close());

	afterEach(() => {
		server.resetHandlers();
		vi.clearAllMocks();
		retryCountState = 0;
	});

	describe("endPoint() - Single Request", () => {
		it("should successfully fetch and serialize JSON", async () => {
			const result = await endPoint<{ foo: string }>(
				"https://api.test.com/success",
			);

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.body).toEqual({ foo: "bar" });
				expect(result.value.status).toBe(200);
				expect(result.value.ok).toBe(true);
			}
		});

		it("should handle POST requests with JSON body", async () => {
			const result = await endPoint("https://api.test.com/post", {
				method: "post",
				json: { hello: "world" },
			});

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.status).toBe(201);
				expect(result.value.body).toEqual({ received: { hello: "world" } });
			}
		});

		it("should successfully handle plain text responses", async () => {
			const result = await endPoint("https://api.test.com/text");

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.body).toBe("plain text");
				expect(result.value.headers["content-type"]).toContain("text/plain");
			}
		});

		it("should return status error for 404 responses (not retried)", async () => {
			const result = await endPoint("https://api.test.com/404");

			expect(result.status).toBe("error");
			if (result.status === "error" && "status" in result.reason) {
				expect(result.reason.status).toBe(404);
				expect(result.reason.ok).toBe(false);
			}
		});

		it("should retry on 429 (Rate Limit) and eventually succeed", async () => {
			const result = await endPoint("https://api.test.com/retry-logic");

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.body).toEqual({ attempts: 3 });
			}
		});

		it("should retry on 500 (Internal Server Error) and eventually succeed", async () => {
			const result = await endPoint("https://api.test.com/500");

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.body).toEqual({ recovered: true });
			}
		});

		it("should log to logger.trace during retries using beforeRetry hook", async () => {
			// biome-ignore lint/style/noNonNullAssertion: logger is mocked in beforeAll
			const traceSpy = vi.spyOn(globalThis.logger!, "trace");

			await endPoint("https://api.test.com/retry-logic");

			expect(traceSpy).toHaveBeenCalledWith(
				expect.stringContaining("Retrying API call"),
			);
		});

		it("should allow custom beforeRetry hooks alongside default one", async () => {
			const customHook = vi.fn();
			// biome-ignore lint/style/noNonNullAssertion: logger is mocked in beforeAll
			const traceSpy = vi.spyOn(globalThis.logger!, "trace");

			await endPoint("https://api.test.com/retry-logic", {
				hooks: {
					beforeRetry: [customHook],
				},
			});

			expect(traceSpy).toHaveBeenCalled(); // Default hook
			expect(customHook).toHaveBeenCalled(); // Custom hook
		});

		it("should handle request timeouts gracefully", async () => {
			const result = await endPoint("https://api.test.com/timeout", {
				timeout: 100,
				retry: { limit: 0 }, // Disable retries to fail fast
			});

			expect(result.status).toBe("error");
			if (result.status === "error") {
				//ky TimeoutError or similar serialized
				expect(result.reason).toHaveProperty("name", "TimeoutError");
			}
		});

		it("should lowercase custom headers and merge them correctly with defaults", async () => {
			server.use(
				http.get("https://api.test.com/headers-test", ({ request }) => {
					return HttpResponse.json({
						contentType: request.headers.get("content-type"),
						custom: request.headers.get("x-custom-header"),
					});
				}),
			);

			const result = await endPoint("https://api.test.com/headers-test", {
				headers: { "X-CUSTOM-HEADER": "test-value" },
			});

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.body).toEqual({
					contentType: "application/json", // from defaults
					custom: "test-value",
				});
			}
		});
	});

	describe("endPoints() - Parallel Requests", () => {
		it("should handle multiple requests in parallel and maintain order", async () => {
			const urls = [
				"https://api.test.com/success",
				"https://api.test.com/text",
				"https://api.test.com/404",
			];

			const results = await endPoints(urls);

			expect(results).toHaveLength(3);
			expect(results[0].status).toBe("success");
			expect(results[1].status).toBe("success");
			expect(results[2].status).toBe("error");

			if (results[0].status === "success")
				expect(results[0].value.body).toEqual({ foo: "bar" });
			if (results[1].status === "success")
				expect(results[1].value.body).toBe("plain text");
		});

		it("should handle network failures in parallel requests", async () => {
			server.use(
				http.get("https://api.test.com/fail", () => {
					return HttpResponse.error();
				}),
			);

			const results = await endPoints(
				["https://api.test.com/success", "https://api.test.com/fail"],
				{ retry: { limit: 0 } },
			);

			expect(results[0].status).toBe("success");
			expect(results[1].status).toBe("error");
			if (results[1].status === "error") {
				expect(results[1].reason).toHaveProperty("name", "TypeError"); // Fetch failure usually TypeError
			}
		});
	});

	describe("Edge Cases & Error Handling", () => {
		it("should handle malformed JSON by falling back to text", async () => {
			server.use(
				http.get("https://api.test.com/malformed", () => {
					return new HttpResponse('{"bad": json', {
						headers: { "Content-Type": "application/json" },
					});
				}),
			);

			const result = await endPoint("https://api.test.com/malformed");

			expect(result.status).toBe("success");
			if (result.status === "success") {
				expect(result.value.body).toBe('{"bad": json');
			}
		});

		it("should use DEFAULT_REQUEST_OPTIONS when no options provided", () => {
			expect(RequestUnlimited.defaults.timeout).toBe(50000);
			expect((RequestUnlimited.defaults.retry as any).limit).toBe(5);
		});
	});
});
