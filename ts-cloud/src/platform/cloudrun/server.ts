import { logger } from "@ckir/corelib";
import { serve } from "@hono/node-server";
import { createRouter } from "../../core/router";

const app = createRouter(logger);

app.use("*", async (c, next) => {
	const logger = c.get("logger");
	logger?.info(`Incoming request: ${c.req.method} ${c.req.url}`);

	(c as any).env = c.env || {};
	c.env.CORELIB_TURSO_URL = process.env.CORELIB_TURSO_URL || "";
	c.env.CORELIB_TURSO_TOKEN = process.env.CORELIB_TURSO_TOKEN || "";
	c.env.PLATFORM = "cloudrun";
	await next();
});
const port = Number(process.env.PORT) || 3000;
const hostname = "0.0.0.0";

console.log(`[BOOT] Initializing server on ${hostname}:${port}...`);

try {
	serve(
		{
			fetch: (req) => {
				console.log(`[SERVE] Incoming: ${req.method} ${req.url}`);
				return app.fetch(req, process.env);
			},
			hostname,
			port,
		},
		(info) => {
			console.log(
				`[BOOT] ✅ Server is successfully listening on http://${info.address}:${info.port}`,
			);
		},
	);
} catch (err) {
	console.error("[BOOT] ❌ Fatal error during serve():", err);
	process.exit(1);
}
