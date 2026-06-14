// Edge stub for server-only dependencies that are NEVER reachable on the
// Cloudflare Workers runtime. In @ckir/corelib these (pino stack, postgres,
// @libsql/client) are loaded only behind runtime-gated dynamic import()s:
//   - the logger resolves ./implementations/cloudflare.js on edge (never node/gcp/lambda),
//   - DB drivers load via `await import(...)` only when createDatabase() opens a connection.
// They are therefore dead on edge, but wrangler's bundler still statically resolves
// the import() specifiers. We alias them (wrangler.toml [alias]) to this stub so the
// worker bundles + boots; if any property is actually touched at runtime it means an
// edge code path tried to use a Node-only dependency — fail loudly rather than silently.
const fail = () => {
	throw new Error(
		"A server-only dependency (pino/postgres/@libsql/client) was invoked on the " +
			"Cloudflare edge runtime, where it is not available. Edge code must not reach " +
			"Node-only logger/database paths (use @libsql/client/web for edge SQL).",
	);
};

const stub = new Proxy(fail, {
	get(_t, prop) {
		// Allow ESM interop probes to no-op; everything else throws on use.
		if (prop === "__esModule" || prop === Symbol.toPrimitive) return undefined;
		return fail;
	},
	apply: fail,
	construct: fail,
});

export default stub;
// Named exports used by the gated dynamic-import call sites in @ckir/corelib.
// (createClient: @libsql/client; createGcpLoggingPinoConfig: @google-cloud/pino-logging-gcp-config.)
export const createClient = fail;
export const createGcpLoggingPinoConfig = fail;
