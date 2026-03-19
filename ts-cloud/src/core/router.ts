import {
	createDatabase,
	endPoint,
	type StrictLogger,
	wrapSuccess,
} from "@ckir/corelib";
import { Hono } from "hono";

export type AppEnv = {
	Bindings: {
		TURSO_URL: string;
		TURSO_TOKEN: string;
		PLATFORM: string;
	};
	Variables: {
		logger: StrictLogger;
	};
};

export const createRouter = () => {
	const app = new Hono<AppEnv>();

	// GET /health -> Returns system status mapped through wrapSuccess.
	app.get("/health", (c) => {
		const platform = c.env.PLATFORM || "unknown";
		return c.json(wrapSuccess({ status: "ok", platform }));
	});

	// ALL /proxy/* -> Forwards the request using endPoint from @ckir/corelib.
	app.all("/proxy/*", async (c) => {
		const url = c.req.path.replace("/proxy/", "");
		if (!url) {
			return c.json({ status: "error", reason: "Missing URL" }, 400);
		}

		const method = c.req.method.toLowerCase() as any;
		const headers = c.req.header();
		const body = ["get", "head"].includes(method)
			? undefined
			: await c.req.text();

		const result = await endPoint(url, {
			method,
			headers,
			body,
		});

		return c.json(result);
	});

	// POST /sql/query -> Executes a parametrized query using createDatabase from @ckir/corelib.
	app.post("/sql/query", async (c) => {
		const { sql, params } = await c.req.json();

		if (!sql) {
			return c.json({ status: "error", reason: "Missing SQL query" }, 400);
		}

		const db = await createDatabase({
			dialect: "sqlite",
			mode: "stateless",
			url: c.env.TURSO_URL,
			authToken: c.env.TURSO_TOKEN,
			logger: c.get("logger"),
		} as any);
		const result = await db.query(sql, params);
		return c.json(result);
	});

	return app;
};
