// =============================================
// B3: Node<->Rust cross-runtime loopback DELIVERY closure (Streaming Engine Epic).
// Drives the REAL AlpacaStreaming addon against the Node `ws` AlpacaLoopbackServer and
// ASSERTS a frame round-trips: Node ws -> Rust driver -> TSFN -> on_pricing ("pricing" event).
// Standard integration tier (plain `it`, no INTEGRATION_LIVE) → GATES CI.
// Closes the Epic-5 finding `probe-harness-loopback-no-delivery`.
// Dummy credentials only; never reads APCA_* env (cannot hit production).
// =============================================
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error - JS harness, no types. If this path won't resolve under the
// integration vitest project, copy the harness to ./_harness/ and import "./_harness/alpaca-loopback.mjs".
import { AlpacaLoopbackServer } from "../../../probes/_harness/alpaca-loopback.mjs";
import { AlpacaStreaming } from "@ckir/corelib-markets";

let server: InstanceType<typeof AlpacaLoopbackServer> | undefined;
let stream: AlpacaStreaming | undefined;

afterEach(async () => {
	try {
		stream?.stop();
	} catch {
		/* ignore */
	}
	try {
		await server?.close();
	} catch {
		/* ignore */
	}
	stream = undefined;
	server = undefined;
});

function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
	return new Promise((res, rej) => {
		const t0 = Date.now();
		const tick = () => {
			if (pred()) return res();
			if (Date.now() - t0 > timeoutMs) return rej(new Error("waitFor timeout"));
			setTimeout(tick, 25);
		};
		tick();
	});
}

it("[b3.alpaca] a frame round-trips Node ws -> Rust -> on_pricing", async () => {
	server = new AlpacaLoopbackServer();
	await server.listen();

	stream = new AlpacaStreaming();
	const pricing = new Promise<any>((res) => stream!.once("pricing", res));

	// dummy creds ONLY; temp db; baseUrl points at the loopback (never production).
	const dbPath = `${tmpdir()}/b3_alpaca_${process.pid}_${Date.now()}.redb`;
	await stream.init({
		baseUrl: server.url,
		keyId: "dummy-key",
		secretKey: "dummy-secret",
		dbPath,
	});
	stream.subscribe(["AAPL"]); // persisted to redb -> driver subscribes on connect
	await stream.start();

	// Once the driver has authed + subscribed, the server marks it streaming-ready.
	await waitFor(() => server!.streamingCount > 0, 10_000);
	server.streamTradeAll("AAPL", 191.5);

	const data = (await Promise.race([
		pricing,
		new Promise((_r, rej) => setTimeout(() => rej(new Error("no pricing in 10s")), 10_000)),
	])) as { symbol: string; messageType: string; price: number };

	expect(data.symbol).toBe("AAPL");
	expect(data.messageType).toBe("trade");
	expect(data.price).toBe(191.5);
}, 30_000);
