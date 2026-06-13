import { http, HttpResponse, passthrough } from "msw";
import { setupServer } from "msw/node";
import { type Fixture, type FixtureFile, fixtureKey, fixturePathFor, readFixtureFile, writeFixtureFile } from "./fixtures";
import { scrubFixture } from "./scrubber";

export const IS_RECORD = process.env.INTEGRATION_RECORD === "1";
export const IS_LIVE = process.env.INTEGRATION_LIVE === "1";

/** Per-test replay queues, keyed by "METHOD url". */
const queues = new Map<string, Fixture[]>();
const misses: string[] = [];
const pendingWrites = new Map<string, Fixture>(); // record mode: path -> scrubbed fixture
let recordTarget: { service: string; name: string } | undefined;
let bypassListenerAttached = false;
let serverStarted = false;

function enqueue(file: FixtureFile): void {
  const arr = Array.isArray(file) ? file : [file];
  if (arr.length === 0) return;
  const key = fixtureKey(arr[0].request.method, arr[0].request.url);
  queues.set(key, [...(queues.get(key) ?? []), ...arr]);
}

/** Register an in-memory fixture (used by tests directly). */
export function registerFixture(file: FixtureFile): void {
  enqueue(file);
}

/** Load a committed fixture file into the replay queue. No-op in live mode. */
export function loadFixture(service: string, name: string): void {
  if (IS_LIVE) return;
  const file = readFixtureFile(fixturePathFor(service, name));
  if (!file) throw new Error(`itest: missing fixture ${service}/${name}.json (record with INTEGRATION_RECORD=1 to create)`);
  enqueue(file);
}

/** In record mode, name the fixture file the next passed-through real response is written to. Side-effect-free (no listeners). */
export function recordTo(service: string, name: string): void {
  if (!IS_RECORD) return;
  recordTarget = { service, name };
}

function nextFixture(method: string, url: string): Fixture | undefined {
  const key = fixtureKey(method, url);
  const q = queues.get(key);
  if (!q || q.length === 0) return undefined;
  return q.length === 1 ? q[0] : q.shift();
}

const replayResolver = http.all("*", async ({ request }) => {
  if (IS_LIVE || IS_RECORD) return passthrough();
  const fx = nextFixture(request.method, request.url);
  if (!fx) {
    misses.push(`${request.method} ${request.url}`);
    return HttpResponse.json({ itestError: "no fixture" }, { status: 599 });
  }
  const body = fx.response.body;
  const init = { status: fx.response.status, headers: fx.response.headers };
  return typeof body === "string" || body == null
    ? new HttpResponse(body as string | null, init)
    : HttpResponse.json(body, init);
});

export const itestServer = setupServer(replayResolver);

export function beginItest(): void {
  if (IS_LIVE) return; // real network; no interception
  if (serverStarted) return; // idempotent: global setup + per-test beforeAll can both call safely
  serverStarted = true;
  itestServer.listen({ onUnhandledRequest: "bypass" });
  if (IS_RECORD && !bypassListenerAttached) {
    bypassListenerAttached = true; // attach exactly once (no per-call leak)
    itestServer.events.on("response:bypass", async ({ request, response }) => {
      const text = await response.clone().text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep string */ }
      const raw: Fixture = {
        request: { method: request.method, url: request.url, headers: Object.fromEntries(request.headers) },
        response: { status: response.status, headers: Object.fromEntries(response.headers), body },
        recordedAt: new Date().toISOString(),
      };
      const scrubbed = scrubFixture(raw);
      const target = recordTarget ?? { service: "_unsorted", name: new URL(request.url).hostname };
      pendingWrites.set(fixturePathFor(target.service, target.name), scrubbed);
      // eslint-disable-next-line no-console
      console.log(`[itest:record] ${target.service}/${target.name} <- ${request.method} ${request.url} (scrubbed before write)`);
    });
  }
}

export function resetItest(): void {
  queues.clear();
  misses.length = 0;
  recordTarget = undefined;
  itestServer.resetHandlers();
}

export function assertNoMisses(): void {
  if (misses.length === 0) return;
  const list = misses.join(", ");
  misses.length = 0;
  throw new Error(`itest: ${list} had no fixture (replay mode). Record with INTEGRATION_RECORD=1.`);
}

export async function endItest(): Promise<void> {
  if (IS_LIVE) return;
  if (!serverStarted) return;
  serverStarted = false;
  if (IS_RECORD) for (const [path, data] of pendingWrites) writeFixtureFile(path, data);
  itestServer.close();
}
