import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireApiToken } from "./auth";
import type { AppEnv } from "./types";

const build = () => {
	const app = new Hono<AppEnv>();
	app.use("*", requireApiToken);
	app.get("/x", (c) => c.json({ ok: true }));
	return app;
};

const env = (token?: string) => ({ CORELIB_API_TOKEN: token }) as never;

describe("requireApiToken", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("accepts the configured bearer token", async () => {
		const res = await build().request(
			"/x",
			{ headers: { authorization: "Bearer s3cret" } },
			env("s3cret"),
		);
		expect(res.status).toBe(200);
	});

	it("rejects a missing Authorization header with 401", async () => {
		const res = await build().request("/x", {}, env("s3cret"));
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
	});

	it.each([
		"Bearer wrong",
		"Bearer s3cret-but-longer",
		"Bearer s3cre",
		"Bearer ",
		"Basic s3cret",
		"s3cret",
	])("rejects %j with 401", async (authorization) => {
		const res = await build().request(
			"/x",
			{ headers: { authorization } },
			env("s3cret"),
		);
		expect(res.status).toBe(401);
	});

	it("fails closed with 503 when no token is configured", async () => {
		const res = await build().request(
			"/x",
			{ headers: { authorization: "Bearer " } },
			env(undefined),
		);
		expect(res.status).toBe(503);
	});

	it("fails closed even when the caller sends an empty token and none is configured", async () => {
		const res = await build().request(
			"/x",
			{ headers: { authorization: "Bearer" } },
			env(""),
		);
		expect(res.status).toBe(503);
	});

	it("falls back to process.env when the binding is absent", async () => {
		vi.stubEnv("CORELIB_API_TOKEN", "from-process");
		const ok = await build().request(
			"/x",
			{ headers: { authorization: "Bearer from-process" } },
			env(undefined),
		);
		expect(ok.status).toBe(200);
	});
});
