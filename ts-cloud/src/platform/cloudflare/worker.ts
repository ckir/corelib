import { createEdgeLogger } from "../../core/logger";
import { createRouter } from "../../core/router";

const app = createRouter();
const logger = createEdgeLogger({ platform: "cloudflare" });

app.use("*", async (c, next) => {
	c.set("logger", logger);
	c.env.PLATFORM = "cloudflare";
	await next();
});

export default {
	fetch: app.fetch,
};
