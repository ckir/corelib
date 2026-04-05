import { handle } from "hono/aws-lambda";
import { createEdgeLogger } from "../../core/logger";
import { createRouter } from "../../core/router";

// Bypass @libsql/client precompile checks for bundled environments
process.env.LIBSQL_SKIP_PRECOMPILE_CHECK = "1";

const logger = createEdgeLogger({ platform: "aws-lambda" });
const app = createRouter(logger);

export const handler = handle(app);
