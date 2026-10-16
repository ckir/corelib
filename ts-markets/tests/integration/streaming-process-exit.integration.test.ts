// =============================================
// Regression: a process must be able to exit once a native streamer is constructed or stopped,
// and must stay alive while a feed is running. The native callbacks are unref'd ThreadsafeFunctions;
// the JS wrappers hold a ref'd timer (ProcessKeepAlive) from start() until stop()/clean().
// Each case runs in a CHILD process because the symptom is "the process never exits".
// Standard integration tier (no INTEGRATION_LIVE): dummy credentials, loopback server only.
// =============================================
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isFfiAvailable } from "@ckirg/corelib";
import { expect, it } from "vitest";

const PKG_DIR = new URL("../..", import.meta.url).pathname;
// Children import the BUILT package (what consumers load); node cannot self-reference it by name here.
const MARKETS = new URL("../../dist/index.js", import.meta.url).href;
const HARNESS = new URL(
	"../../../probes/_harness/alpaca-loopback.mjs",
	import.meta.url,
).pathname;

function run(code: string): ChildProcess {
	return spawn(process.execPath, ["--input-type=module", "-e", code], {
		cwd: PKG_DIR,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function exited(child: ChildProcess, ms: number): Promise<number | "alive"> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve("alive"), ms);
		child.once("exit", (code) => {
			clearTimeout(t);
			resolve(code ?? -1);
		});
	});
}

const FEED = `
import { AlpacaStreaming } from ${JSON.stringify(MARKETS)};
import { AlpacaLoopbackServer } from ${JSON.stringify(HARNESS)};
import { tmpdir } from "node:os";
const server = new AlpacaLoopbackServer(); await server.listen();
const s = new AlpacaStreaming();
await s.init({ baseUrl: server.url, keyId: "dummy", secretKey: "dummy",
  dbPath: tmpdir() + "/exit_" + process.pid + "_" + Date.now() + ".redb" });
s.subscribe(["AAPL"]); await s.start();
const dl = Date.now() + 10000;
while (!(server.streamingCount > 0) && Date.now() < dl) await new Promise((r) => setTimeout(r, 25));
await server.close();
`;

// Needs the native addon and a built dist/ (`pnpm build`); skipped otherwise, like the other FFI tests.
const suite = it.skipIf(!isFfiAvailable() || !existsSync(new URL(MARKETS)));

for (const name of ["AlpacaStreaming", "FinnhubStreaming", "YahooStreaming"]) {
	suite(`[exit] a process that only constructs ${name} exits on its own`, async () => {
		const child = run(
			`import { ${name} } from ${JSON.stringify(MARKETS)}; const s = new ${name}(); await s.init({});`,
		);
		expect(await exited(child, 8_000)).toBe(0);
		child.kill();
	}, 15_000);
}

suite("[exit] a running AlpacaStreaming feed keeps the process alive until stop() is called", async () => {
	const child = run(`${FEED}\nawait new Promise(() => {});`);
	// Nothing else holds the loop open (server closed): only the feed's keep-alive does.
	expect(await exited(child, 4_000)).toBe("alive");
	child.kill();
}, 20_000);

suite("[exit] a process exits on its own after stop()", async () => {
	const child = run(`${FEED}\ns.stop();`);
	expect(await exited(child, 8_000)).toBe(0);
	child.kill();
}, 20_000);
