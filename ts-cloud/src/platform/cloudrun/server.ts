import { serve } from "@hono/node-server";
import { createEdgeLogger } from "../../core/logger";
import { createRouter } from "../../core/router";

const app = createRouter();
const logger = createEdgeLogger({ platform: "cloudrun" });

app.use("*", async (c, next) => {
	c.set("logger", logger);
	c.env.CORELIB_TURSO_URL = process.env.CORELIB_TURSO_URL || "";
	c.env.CORELIB_TURSO_TOKEN = process.env.CORELIB_TURSO_TOKEN || "";
	c.env.PLATFORM = "cloudrun";
	await next();
});
const port = Number(process.env.PORT) || 3000;
console.log(`Server is running on port ${port}`);

serve({
	fetch: app.fetch,
	hostname: "0.0.0.0",
	port,
});
