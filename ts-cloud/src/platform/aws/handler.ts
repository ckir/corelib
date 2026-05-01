import { handle } from "hono/aws-lambda";
import { createEdgeLogger } from "../../core/logger";
import { createRouter } from "../../core/router";

// Bypass @libsql/client precompile checks for bundled environments
process.env.LIBSQL_SKIP_PRECOMPILE_CHECK = "1";

const handlerLogger = createEdgeLogger({
	platform: "aws-lambda",
	section: "Handler",
});
const app = createRouter(handlerLogger);

export const handler = handle(app);
