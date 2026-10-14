// Fails if the built browser entry (ts-core/dist/browser.js) or any chunk it reaches imports a Node
// builtin. The entry ships to browsers and edge workers, where such an import breaks bundling or
// crashes at load. Checking the *built* output (not the source graph) is deliberate: ts-core guards
// its node: imports with the __EDGE_RUNTIME__ build-time define, which only the bundler resolves.
// Run after `pnpm build-all`: `pnpm check:browser-bundle`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DIST = resolve("ts-core/dist");
const ENTRY = join(DIST, "browser.js");
const BUILTINS =
	"node:[a-z_/]+|fs|fs/promises|path|os|crypto|module|child_process|net|tls|dns|worker_threads|http|https|http2|stream|zlib|url|util|events|buffer|async_hooks|process|readline|vm|cluster|dgram|perf_hooks";
const BUILTIN_IMPORT = new RegExp(
	`(?:from|import|require)\\s*\\(?\\s*["'](${BUILTINS})["']`,
	"g",
);
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g;

if (!existsSync(ENTRY)) {
	console.error(`${ENTRY} not found: build ts-core first (pnpm build-all).`);
	process.exit(2);
}

const seen = new Set();
const offenders = [];
const queue = [ENTRY];
while (queue.length > 0) {
	const file = queue.pop();
	if (seen.has(file)) continue;
	seen.add(file);
	const code = readFileSync(file, "utf8");
	for (const m of code.matchAll(BUILTIN_IMPORT)) {
		offenders.push(`${file.slice(DIST.length + 1)} imports "${m[1]}"`);
	}
	for (const m of code.matchAll(RELATIVE_IMPORT)) {
		const next = resolve(dirname(file), m[1]);
		if (existsSync(next)) queue.push(next);
	}
}

if (offenders.length > 0) {
	console.error("Browser bundle reaches Node builtins:");
	for (const o of offenders) console.error(`  - ${o}`);
	process.exit(1);
}
console.log(`browser bundle OK: ${seen.size} files, no Node builtin imports`);
