import { logger } from "@ckir/corelib";
import { serve } from "@hono/node-server";
import { serializeError } from "serialize-error";
import { createRouter } from "../../core/router";

const serverLogger = logger.child({ section: "Server" });
const app = createRouter(serverLogger);

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

serverLogger.info(`Initializing server on ${hostname}:${port}`);

try {
	serve(
		{
			fetch: (req) => {
				serverLogger.info(`Incoming: ${req.method} ${req.url}`);
				return app.fetch(req, process.env);
			},
			hostname,
			port,
		},
		(info) => {
			serverLogger.info(
				`Server listening on http://${info.address}:${info.port}`,
			);
		},
	);
} catch (err) {
	serverLogger.error("Fatal error during serve()", {
		error: serializeError(err),
	});
	process.exit(1);
}
