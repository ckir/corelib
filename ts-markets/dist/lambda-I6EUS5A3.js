import {
  StrictLoggerWrapper
} from "./chunk-Z3SL7VUJ.js";
import "./chunk-HSLFBTA7.js";
import {
  __commonJS,
  __require,
  __toESM
} from "./chunk-JRTXIK2V.js";

// ../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/context.js
var require_context = __commonJS({
  "../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/context.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.GlobalContextStorageProvider = void 0;
    var CONTEXT_SYMBOL = /* @__PURE__ */ Symbol.for("aws.lambda.runtime.context");
    exports.GlobalContextStorageProvider = {
      getContext: () => global[CONTEXT_SYMBOL],
      setContext: (map) => global[CONTEXT_SYMBOL] = map,
      updateContext: (values) => {
        const ctx = exports.GlobalContextStorageProvider.getContext();
        global[CONTEXT_SYMBOL] = {
          ...ctx,
          ...values
        };
      }
    };
  }
});

// ../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/formatters/format.js
var require_format = __commonJS({
  "../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/formatters/format.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.formatLevel = void 0;
    var pino_1 = __importDefault(__require("pino"));
    var formatLevel = (level) => {
      var _a;
      if (typeof level === "string") {
        return level.toLocaleUpperCase();
      } else if (typeof level === "number") {
        return (_a = pino_1.default.levels.labels[level]) === null || _a === void 0 ? void 0 : _a.toLocaleUpperCase();
      }
      return level;
    };
    exports.formatLevel = formatLevel;
  }
});

// ../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/formatters/lambda.js
var require_lambda = __commonJS({
  "../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/formatters/lambda.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CloudwatchLogFormatter = void 0;
    var format_1 = require_format();
    var CloudwatchLogFormatter = class {
      format(data) {
        const { awsRequestId, level, msg } = data;
        const time = (/* @__PURE__ */ new Date()).toISOString();
        const levelTag = format_1.formatLevel(level);
        return `${time}${awsRequestId ? `	${awsRequestId}` : ""}	${levelTag}	${msg}	${JSON.stringify(data)}`;
      }
    };
    exports.CloudwatchLogFormatter = CloudwatchLogFormatter;
  }
});

// ../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/formatters/pino.js
var require_pino = __commonJS({
  "../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/formatters/pino.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PinoLogFormatter = void 0;
    var PinoLogFormatter = class {
      format(data) {
        return JSON.stringify(data);
      }
    };
    exports.PinoLogFormatter = PinoLogFormatter;
  }
});

// ../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/formatters/structured.js
var require_structured = __commonJS({
  "../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/formatters/structured.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.StructuredLogFormatter = void 0;
    var format_1 = require_format();
    var StructuredLogFormatter = class {
      format({ awsRequestId, level, ...data }) {
        return JSON.stringify({
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          level: format_1.formatLevel(level),
          requestId: awsRequestId,
          message: data
        });
      }
    };
    exports.StructuredLogFormatter = StructuredLogFormatter;
  }
});

// ../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/formatters/index.js
var require_formatters = __commonJS({
  "../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/formatters/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      Object.defineProperty(o, k2, { enumerable: true, get: function() {
        return m[k];
      } });
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    __exportStar(require_lambda(), exports);
    __exportStar(require_pino(), exports);
    __exportStar(require_structured(), exports);
  }
});

// ../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/destination.js
var require_destination = __commonJS({
  "../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/destination.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.pinoLambdaDestination = void 0;
    var stream_1 = __require("stream");
    var context_1 = require_context();
    var formatters_1 = require_formatters();
    var pinoLambdaDestination = (options = {}) => {
      const writeable = new stream_1.Writable({
        defaultEncoding: "utf8",
        write(chunk, encoding, callback) {
          const storageProvider = options.storageProvider || context_1.GlobalContextStorageProvider;
          const formatter = options.formatter || new formatters_1.CloudwatchLogFormatter();
          const data = JSON.parse(chunk);
          const lambdaContext = storageProvider.getContext() || {};
          let output = formatter.format({ ...lambdaContext, ...data });
          output = output.replace(/\n/, "\r");
          output += "\n";
          if (options.streamWriter) {
            options.streamWriter(output);
          } else {
            process.stdout.write(output);
          }
          callback();
        }
      });
      return writeable;
    };
    exports.pinoLambdaDestination = pinoLambdaDestination;
  }
});

// ../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/request.js
var require_request = __commonJS({
  "../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/request.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.lambdaRequestTracker = void 0;
    var context_1 = require_context();
    var AMAZON_TRACE_ID = "_X_AMZN_TRACE_ID";
    var CORRELATION_HEADER = "x-correlation-";
    var CORRELATION_ID = `${CORRELATION_HEADER}id`;
    var CORRELATION_TRACE_ID = `${CORRELATION_HEADER}trace-id`;
    var lambdaRequestTracker = (options = {}) => (event, context) => {
      var _a;
      const ctx = {
        awsRequestId: context.awsRequestId
      };
      const apiRequestId = (_a = event.requestContext) === null || _a === void 0 ? void 0 : _a.requestId;
      if (apiRequestId) {
        ctx.apiRequestId = apiRequestId;
      }
      if (event.headers) {
        for (const [header, value] of Object.entries(event.headers)) {
          if (header.toLowerCase().startsWith(CORRELATION_HEADER)) {
            ctx[header] = value;
          }
        }
      }
      if (process.env[AMAZON_TRACE_ID]) {
        ctx[CORRELATION_TRACE_ID] = process.env[AMAZON_TRACE_ID];
      }
      if (!ctx[CORRELATION_ID]) {
        ctx[CORRELATION_ID] = context.awsRequestId;
      }
      if (options.requestMixin) {
        const result = options.requestMixin(event, context);
        for (const key in result) {
          ctx[key] = result[key];
        }
      }
      const storageProvider = options.storageProvider || context_1.GlobalContextStorageProvider;
      if (storageProvider) {
        storageProvider.setContext(ctx);
      }
    };
    exports.lambdaRequestTracker = lambdaRequestTracker;
  }
});

// ../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/types.js
var require_types = __commonJS({
  "../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
  }
});

// ../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/index.js
var require_dist = __commonJS({
  "../node_modules/.pnpm/pino-lambda@4.4.1_pino@10.3.1/node_modules/pino-lambda/dist/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      Object.defineProperty(o, k2, { enumerable: true, get: function() {
        return m[k];
      } });
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    __exportStar(require_context(), exports);
    __exportStar(require_destination(), exports);
    __exportStar(require_formatters(), exports);
    __exportStar(require_request(), exports);
    __exportStar(require_types(), exports);
  }
});

// ../ts-core/src/loggers/implementations/lambda.ts
var import_pino_lambda = __toESM(require_dist(), 1);
import pino from "pino";
function createLambdaLogger() {
  const lambdaFnRaw = import_pino_lambda.default;
  const lambdaFn = typeof lambdaFnRaw === "function" ? lambdaFnRaw : lambdaFnRaw.default || lambdaFnRaw.pinoLambda;
  let destination;
  if (typeof lambdaFn === "function") {
    try {
      destination = lambdaFn();
    } catch (_e) {
      console.warn("pino-lambda destination creation failed, using default");
    }
  }
  const logger = pino(
    {
      level: process.env.LOG_LEVEL || "info",
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: ["password", "secret", "token", "authorization"]
    },
    destination
  );
  return new StrictLoggerWrapper(logger);
}
export {
  createLambdaLogger as default
};
