import { handle } from "hono/aws-lambda";
import { createEdgeLogger } from "../../core/logger";
import { createRouter } from "../../core/router";

const app = createRouter();
const logger = createEdgeLogger({ platform: "aws-lambda" });

app.use("*", async (c, next) => {
	c.set("logger", logger);
	// Inject process.env into c.env if not already there
	c.env.CORELIB_TURSO_URL = process.env.CORELIB_TURSO_URL || "";
	c.env.CORELIB_TURSO_TOKEN = process.env.CORELIB_TURSO_TOKEN || "";
	c.env.PLATFORM = "aws-lambda";
	await next();
});

export const handler = handle(app);
