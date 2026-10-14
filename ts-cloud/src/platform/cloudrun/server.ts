import { logger } from "@ckirg/corelib";
import { serve } from "@hono/node-server";
import { serializeError } from "serialize-error";
import { createRouter } from "../../core/router";

const serverLogger = logger.child({ section: "Server" });
const app = createRouter(serverLogger, { platform: "cloudrun" });

const port = Number(process.env.PORT) || 3000;
const hostname = "0.0.0.0";

serverLogger.info(`Initializing server on ${hostname}:${port}`);

try {
	serve(
		{
			fetch: (req) => {
				serverLogger.info("Incoming request", {
					method: req.method,
					path: new URL(req.url).pathname,
				});
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
