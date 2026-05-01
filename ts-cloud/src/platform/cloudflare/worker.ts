import { logger } from "@ckir/corelib";
import { createRouter } from "../../core/router";

const workerLogger = logger.child({ section: "Worker" });
const app = createRouter(workerLogger);

app.use("*", async (c, next) => {
	const logger = c.get("logger");
	logger?.info(`Incoming request: ${c.req.method} ${c.req.url}`);

	(c as any).env = c.env || {};
	c.env.PLATFORM = "cloudflare";
	await next();
});

export default {
	fetch: (request: Request, env: any, ctx: any) => {
		return app.fetch(request, env, ctx);
	},
};
