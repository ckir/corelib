// =============================================
// PROBE: edge-boot (B1.5) — does ts-core's node:* imports break the Worker?
// =============================================
// QUESTION (disputed audit finding): ts-core has unconditional top-level imports
//   - `import { createRequire } from "node:module"`  (core/index.ts, utils/index.ts, utils/SysInfo.ts)
//   - `import crypto from "node:crypto"`              (configs/ConfigUtils.ts)
// Several findings claim these make the Cloudflare Worker FAIL TO LOAD on workerd.
// The dispute: under `compatibility_flags=["nodejs_compat"]` at
// `compatibility_date="2025-02-04"` (ts-cloud/wrangler.toml), does workerd PROVIDE
// node:module / node:crypto at load (worker boots), or does the static import throw
// a module-resolution / named-export error at load (worker undeployable)?
//
// REAL DEPLOY PATH: ts-cloud/wrangler.toml sets
//   main = "src/platform/cloudflare/worker.ts"
// so the production deploy bundles worker.ts with wrangler's own (workers-aware,
// nodejs_compat-applying) esbuild — NOT tsup's platform:"node" output. worker.ts
// imports `@ckirg/corelib`, which resolves to ts-core/dist/index.js (tsup build),
// and THAT dist contains the disputed `createRequire`/crypto imports. Booting the
// worker via wrangler therefore tests the actual production-deploy question.
//
// METHOD: boot the worker locally on workerd via wrangler's programmatic
// `unstable_dev` API (local: true => workerd, no network/login), using the REAL
// ts-cloud/wrangler.toml (config path passed; cwd = ts-cloud). Then fetch("/"),
// capture status+body, and stop the worker. Hard wall-clock cap; always teardown.
//
// ORACLE (the deliverable — printed verbatim as OUTCOME=...):
//   BOOTS_CLEAN       — worker started and fetch("/") returned ANY HTTP response,
//                       even an app-level 404/500/exception. Means nodejs_compat
//                       resolved node:module/node:crypto at load.
//   MODULE_LOAD_ERROR — startup/bundling threw, or a module-resolution error was
//                       surfaced (e.g. "No such module 'node:module'", "does not
//                       provide an export named 'createRequire'", node:crypto not
//                       supported, or a workerd bundling failure naming node:*).
//   INCONCLUSIVE      — wrangler couldn't run for an unrelated reason (missing
//                       binding unrelated to node:* imports, Windows wrangler bug).
//
// An app-level error AFTER the module loaded (thrown handler, missing Turso/env
// binding) is BOOTS_CLEAN: the imports resolved. Only a failure to LOAD/RESOLVE
// the node:* modules is MODULE_LOAD_ERROR.
//
// RUN: `node probes/_harness/edge-boot.mjs`  (from repo root)
// Durable: re-runnable, no network, self-terminating (workerd torn down in finally).
// =============================================

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsCloudDir = path.join(repoRoot, "ts-cloud");
const wranglerConfig = path.join(tsCloudDir, "wrangler.toml");

// Resolve wrangler from ts-cloud's dependency tree (it's a devDependency there).
const requireFromCloud = createRequire(path.join(tsCloudDir, "package.json"));
const { unstable_dev } = requireFromCloud("wrangler");

const HARD_TIMEOUT_MS = 80_000; // overall wall-clock cap; budget is <=90s

// Classify any thrown/captured text as a node:* module-load error vs not.
function namesNodeModuleLoadError(text) {
	if (!text) return null;
	const s = String(text);
	const patterns = [
		/No such module ['"]?node:module/i,
		/No such module ['"]?node:crypto/i,
		/No such module ['"]?module['"]/i,
		/No such module ['"]?crypto['"]/i,
		/does not provide an export named ['"]?createRequire/i,
		/node:crypto[\s\S]{0,40}not supported/i,
		/node:module[\s\S]{0,40}not supported/i,
		/Cannot find module ['"]?node:(module|crypto)/i,
		/(module|crypto)[\s\S]{0,30}not (supported|available)[\s\S]{0,30}workerd/i,
	];
	for (const p of patterns) {
		const m = s.match(p);
		if (m) return m[0];
	}
	return null;
}

function out(outcome, detail) {
	console.log("");
	console.log("==================== EDGE-BOOT PROBE RESULT ====================");
	console.log(`OUTCOME=${outcome}`);
	console.log(detail);
	console.log("===============================================================");
}

let worker;
let timeoutHandle;
let timedOut = false;

const timeoutPromise = new Promise((_, reject) => {
	timeoutHandle = setTimeout(() => {
		timedOut = true;
		reject(new Error(`PROBE_TIMEOUT after ${HARD_TIMEOUT_MS}ms`));
	}, HARD_TIMEOUT_MS);
	timeoutHandle.unref?.();
});

async function runProbe() {
	// Guard: the probe must load the BUILT asset, not the TS source.
	// If the build is missing, fail loudly so the runner knows to build first.
	const builtWorker = path.join(tsCloudDir, "dist", "cloudflare", "worker.js");
	if (!existsSync(builtWorker)) {
		console.error(
			`\n[probe] FATAL: built asset not found:\n  ${builtWorker}\n` +
			`Run \`pnpm build-all\` from the repo root first, then re-run this probe.\n`,
		);
		process.exit(1);
	}
	console.error(`[probe] booting worker via unstable_dev (config=${wranglerConfig})`);
	console.error(`[probe] entry (built asset): dist/cloudflare/worker.js`);
	// wrangler's unstable_dev resolves the script + config relative to process cwd,
	// not the config dir. Run from ts-cloud so the entry-point, wrangler.toml and
	// the @ckirg/corelib resolution all match the REAL deploy layout.
	process.chdir(tsCloudDir);
	// Entry is relative to tsCloudDir (process cwd after chdir above).
	// "dist/cloudflare/worker.js" is the tsup output — the REAL deployable bundle,
	// not the TS source that wrangler would recompile on the fly.
	worker = await unstable_dev("dist/cloudflare/worker.js", {
		config: wranglerConfig,
		// wrangler resolves main/script relative to config dir; also force cwd.
		// Explicit flags mirror wrangler.toml so the test is unambiguous:
		compatibilityDate: "2025-02-04",
		compatibilityFlags: ["nodejs_compat"],
		local: true,
		experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
		// Quieten wrangler's own logging where possible.
		logLevel: "log",
	});

	console.error("[probe] worker started; issuing fetch('/')");
	const res = await worker.fetch("/", { method: "GET" });
	const status = res.status;
	let body = "";
	try {
		body = await res.text();
	} catch (e) {
		body = `<failed to read body: ${e?.message ?? e}>`;
	}
	const snippet = body.slice(0, 200);

	// A response of any kind means the module graph loaded. But double-check the
	// body/status didn't itself carry a workerd module-load error string.
	const inBody = namesNodeModuleLoadError(body);
	if (inBody) {
		out(
			"MODULE_LOAD_ERROR",
			`fetch returned, but body names a module-load failure: ${JSON.stringify(inBody)}\n` +
				`HTTP status: ${status}\nbody[0..200]: ${JSON.stringify(snippet)}`,
		);
		return;
	}

	out(
		"BOOTS_CLEAN",
		`Worker booted on workerd and fetch('/') returned an HTTP response.\n` +
			`HTTP status: ${status}\nbody[0..200]: ${JSON.stringify(snippet)}\n` +
			`=> workerd nodejs_compat RESOLVED node:module / node:crypto at load (imports did not break loading).`,
	);
}

let exitCode = 0;
try {
	await Promise.race([runProbe(), timeoutPromise]);
} catch (err) {
	const text =
		(err && (err.stack || err.message)) ? `${err.message}\n${err.stack ?? ""}` : String(err);
	const named = namesNodeModuleLoadError(text);
	if (named) {
		out(
			"MODULE_LOAD_ERROR",
			`Worker failed to load with a node:* module-resolution error.\n` +
				`Matched: ${JSON.stringify(named)}\n\nFull error:\n${text}`,
		);
	} else if (timedOut || /PROBE_TIMEOUT/.test(text)) {
		out(
			"INCONCLUSIVE",
			`Probe exceeded its wall-clock budget (${HARD_TIMEOUT_MS}ms) before a result.\n` +
				`This is NOT a node:* failure; likely wrangler/workerd startup on Windows.\nFull error:\n${text}`,
		);
		exitCode = 2;
	} else {
		// Some other startup failure. Surface it raw; controller adjudicates whether
		// it is node:*-related (MODULE_LOAD_ERROR) or unrelated (INCONCLUSIVE).
		out(
			"INCONCLUSIVE",
			`Worker did not return a response, but the error does NOT name node:module/node:crypto.\n` +
				`Inspect to classify (unrelated binding / Windows wrangler issue vs hidden load error).\nFull error:\n${text}`,
		);
		exitCode = 2;
	}
} finally {
	clearTimeout(timeoutHandle);
	if (worker) {
		try {
			await worker.stop();
			console.error("[probe] worker stopped cleanly");
		} catch (e) {
			console.error(`[probe] worker.stop() threw (ignored): ${e?.message ?? e}`);
		}
	}
}

// Force-exit so no lingering workerd child keeps the process alive.
process.exit(exitCode);
