import { logger } from "@ckirg/corelib";
import { createRouter } from "../../core/router";
import type { AppEnv } from "../../core/types";

const workerLogger = logger.child({ section: "Worker" });
const app = createRouter(workerLogger, { platform: "cloudflare" });

export default {
	fetch: (request: Request, env: AppEnv["Bindings"], ctx: ExecutionContext) => {
		return app.fetch(request, env, ctx);
	},
};
