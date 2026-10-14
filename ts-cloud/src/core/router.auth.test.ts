import { beforeEach, describe, expect, it, vi } from "vitest";

const endPoint = vi.fn();

vi.mock("@ckirg/corelib", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ckirg/corelib")>();
	return { ...actual, endPoint: (...a: unknown[]) => endPoint(...a) };
});

import { createRouter } from "./router";

const TOKEN = "test-token";
const env = { CORELIB_API_TOKEN: TOKEN } as never;
const authed = {
	authorization: `Bearer ${TOKEN}`,
	"content-type": "application/json",
};

const post = (
	path: string,
	body: unknown,
	headers: Record<string, string> = authed,
) =>
	createRouter().request(
		path,
		{ method: "POST", headers, body: JSON.stringify(body) },
		env,
	);

describe("router authentication", () => {
	beforeEach(() => {
		endPoint.mockReset();
	});

	it("keeps health endpoints public", async () => {
		const app = createRouter();
		expect((await app.request("/health", {}, env)).status).toBe(200);
		expect((await app.request("/api/v1/health", {}, env)).status).toBe(200);
	});

	it.each([
		["POST", "/api/v1/sql", { sql: "DROP TABLE x" }],
		["POST", "/api/v1/ky", { url: "https://example.com/" }],
		["GET", "/api/v1/ky?url=https://example.com/", undefined],
		["POST", "/api/v1/markets/nasdaq", { url: "https://api.nasdaq.com/x" }],
		["GET", "/api/v1/markets/nasdaq/status", undefined],
		["GET", "/api/v1/tests/logger", undefined],
	] as const)(
		"%s %s without a token is 401 and does nothing",
		async (method, path, body) => {
			const res = await createRouter().request(
				path,
				{
					method,
					headers: { "content-type": "application/json" },
					body: body ? JSON.stringify(body) : undefined,
				},
				env,
			);
			expect(res.status).toBe(401);
			expect(endPoint).not.toHaveBeenCalled();
		},
	);

	it("rejects a wrong token", async () => {
		const res = await post(
			"/api/v1/ky",
			{ url: "https://example.com/" },
			{ authorization: "Bearer nope", "content-type": "application/json" },
		);
		expect(res.status).toBe(401);
		expect(endPoint).not.toHaveBeenCalled();
	});

	it("denies everything (503) when the deployment has no token configured", async () => {
		const res = await createRouter().request(
			"/api/v1/sql",
			{
				method: "POST",
				headers: {
					authorization: "Bearer anything",
					"content-type": "application/json",
				},
				body: JSON.stringify({ sql: "SELECT 1" }),
			},
			{} as never,
		);
		expect(res.status).toBe(503);
	});
});
