/**
 * @file ts-cloud/src/core/request-context.ts
 * @description Per-request AsyncLocalStorage carrying the flight-recorder request id (rid).
 *
 * The router mints an `rid` per request and runs the downstream handlers inside this
 * storage. Deep call sites (e.g. createDatabase's `getTraceId` hook) can then read the
 * rid WITHOUT threading a telemetry token through every business signature — the same
 * "ALS where supported, graceful degradation where not" pattern corelib's
 * transaction-context already uses for `txId`.
 *
 * Edge-runtime safety: AsyncLocalStorage is loaded defensively. Where it is unavailable
 * (e.g. a Cloudflare Worker without `nodejs_compat`), `getRequestId()` returns undefined
 * and `runInRequest` simply runs the callback — the DB `getTraceId` then omits traceId
 * cleanly (Tier-3 degrades safely).
 */

/** Minimal AsyncLocalStorage surface used here (avoids a hard node:async_hooks type dep). */
interface AsyncLocalStorageLike<T> {
	run<R>(store: T, callback: () => R): R;
	getStore(): T | undefined;
}

/** Context carried for the lifetime of one HTTP request. */
interface RequestContext {
	/** Flight-recorder request id; surfaces as the DB `traceId` for queries run in this request. */
	rid: number;
}

async function loadAsyncLocalStorage<T>(): Promise<
	AsyncLocalStorageLike<T> | undefined
> {
	try {
		const { AsyncLocalStorage } = await import("node:async_hooks");
		return new AsyncLocalStorage<T>();
	} catch {
		// No async_hooks on this runtime — callers degrade to no correlation.
		return undefined;
	}
}

// Singleton, lazily initialized. Top-level await mirrors transaction-context.ts.
const requestStorage = await loadAsyncLocalStorage<RequestContext>();

/**
 * Returns the active request's flight-recorder id, or undefined outside a request
 * (or where AsyncLocalStorage is unavailable).
 */
export function getRequestId(): number | undefined {
	return requestStorage?.getStore()?.rid;
}

/**
 * Runs `callback` with `rid` bound as the active request id. If AsyncLocalStorage is
 * unavailable, runs the callback unchanged (correlation simply isn't threaded).
 */
export async function runInRequest<T>(
	rid: number,
	callback: () => Promise<T>,
): Promise<T> {
	if (!requestStorage) {
		return callback();
	}
	return requestStorage.run({ rid }, callback);
}
