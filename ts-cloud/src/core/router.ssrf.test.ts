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

describe("generic proxy /api/v1/ky SSRF guard", () => {
	beforeEach(() => {
		endPoint.mockReset();
		endPoint.mockResolvedValue({
			status: "success",
			value: { status: 200, body: { ok: true } },
		});
	});

	it.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://169.254.170.2/v2/credentials",
		"http://localhost:8080/",
		"http://[::1]/",
		"file:///etc/passwd",
	])("POST url=%s is 400 and never fetched", async (url) => {
		const res = await post("/api/v1/ky", { url });
		expect(res.status).toBe(400);
		expect(endPoint).not.toHaveBeenCalled();
	});

	it("GET ?url= to an internal address is 400 and never fetched", async () => {
		const res = await createRouter().request(
			`/api/v1/ky?url=${encodeURIComponent("http://169.254.169.254/")}`,
			{ headers: authed },
			env,
		);
		expect(res.status).toBe(400);
		expect(endPoint).not.toHaveBeenCalled();
	});

	it("bulk: blocks internal entries per item and still fetches the public ones", async () => {
		const res = await post("/api/v1/ky", {
			endPoints: [
				{ url: "http://169.254.169.254/" },
				{ url: "https://example.com/" },
			],
		});
		expect(res.status).toBe(200);
		const out = (await res.json()) as Array<{ status: string }>;
		expect(out.map((r) => r.status)).toEqual(["error", "success"]);
		expect(endPoint).toHaveBeenCalledTimes(1);
		expect(endPoint).toHaveBeenCalledWith("https://example.com/", {});
	});

	it("still proxies a public URL", async () => {
		const res = await post("/api/v1/ky", { url: "https://example.com/data" });
		expect(res.status).toBe(200);
		expect(endPoint).toHaveBeenCalledWith("https://example.com/data", {});
	});
});

describe("nasdaq proxy /api/v1/markets/nasdaq host restriction", () => {
	beforeEach(() => {
		endPoint.mockReset();
		endPoint.mockResolvedValue({
			status: "success",
			value: { status: 200, body: { data: 1 } },
		});
	});

	it.each([
		"https://example.com/",
		"https://evilnasdaq.com/",
		"https://nasdaq.com.evil.io/",
		"http://169.254.169.254/",
	])("POST url=%s is 400 and never fetched", async (url) => {
		const res = await post("/api/v1/markets/nasdaq", { url });
		expect(res.status).toBe(400);
		expect(endPoint).not.toHaveBeenCalled();
	});

	it("GET ?url= to a non-Nasdaq host is 400", async () => {
		const res = await createRouter().request(
			`/api/v1/markets/nasdaq?url=${encodeURIComponent("https://example.com/")}`,
			{ headers: authed },
			env,
		);
		expect(res.status).toBe(400);
		expect(endPoint).not.toHaveBeenCalled();
	});

	it("bulk: a non-Nasdaq or url-less entry fails per item without sinking the batch", async () => {
		const res = await post("/api/v1/markets/nasdaq", {
			endPoints: [
				{ url: "https://example.com/" },
				{},
				{ url: "https://api.nasdaq.com/api/quote/AAPL/info" },
			],
		});
		expect(res.status).toBe(200);
		const out = (await res.json()) as Array<{ status: string }>;
		expect(out.map((r) => r.status)).toEqual(["error", "error", "success"]);
		expect(endPoint).toHaveBeenCalledTimes(1);
	});

	it("still proxies api.nasdaq.com", async () => {
		const res = await post("/api/v1/markets/nasdaq", {
			url: "https://api.nasdaq.com/api/quote/AAPL/info",
		});
		expect(res.status).toBe(200);
		expect(endPoint).toHaveBeenCalledTimes(1);
	});
});
