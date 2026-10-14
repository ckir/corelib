// =============================================
// FILE: ts-markets/src/nasdaq/datafeeds/streaming/nativeCallbacks.ts
// PURPOSE: Shared adapters for the error-first (err, value) callbacks the native
// streaming addons invoke. Keeps bad native input from emitting bogus events,
// counting dead ticks, or throwing inside the native callback.
// =============================================

import type { EventEmitter } from "node:events";
import type { StrictLogger } from "@ckirg/corelib";
import type { StreamHealthTracker } from "./StreamHealthTracker.js";

/** Connection/lifecycle event names the native streamers emit (or document emitting). */
export const NATIVE_EVENT_TYPES: ReadonlySet<string> = new Set([
	"connected",
	"disconnected",
	"reconnecting",
	"silence-reconnect",
	"error",
]);

type NativeCallback<T> = (err: unknown, value: T) => void;

export interface NativeCallbacks<P = unknown> {
	onLog: NativeCallback<unknown>;
	onPricing: NativeCallback<P>;
	onEvent: NativeCallback<
		{ type?: unknown; data?: unknown } | null | undefined
	>;
	onMarket: NativeCallback<string>;
}

/**
 * Builds the four native callbacks (log, pricing, event, market) for a streaming facade.
 *
 * - A set `err` is logged and the value ignored (no emit, no tick recorded).
 * - Unparseable market JSON is logged (length only, never the payload).
 * - Event types are whitelisted; `error` is only emitted when somebody listens
 *   (an unlistened `error` emit throws inside the native callback); unknown types are logged and dropped.
 */
export function createNativeCallbacks<P = unknown>(
	emitter: EventEmitter,
	health: Pick<StreamHealthTracker, "recordTick">,
	log: StrictLogger,
): NativeCallbacks<P> {
	return {
		onLog: (err, record) => {
			if (err) {
				log.error("Native log callback reported an error", { error: err });
				return;
			}
			emitter.emit("log", record);
		},
		onPricing: (err, data) => {
			if (err) {
				log.error("Native pricing callback reported an error", { error: err });
				return;
			}
			health.recordTick();
			emitter.emit("pricing", data);
		},
		onEvent: (err, event) => {
			if (err) {
				log.error("Native event callback reported an error", { error: err });
				return;
			}
			if (!event) return;
			const type = typeof event.type === "string" ? event.type : "";
			if (!NATIVE_EVENT_TYPES.has(type)) {
				log.warn("Ignoring unknown native event type", {
					type: String(event.type),
				});
				return;
			}
			const data = event.data ?? null;
			if (type === "error") {
				if (emitter.listenerCount("error") > 0) {
					emitter.emit("error", data);
				} else {
					log.error("Native stream error (no 'error' listener)", { data });
				}
				return;
			}
			emitter.emit(type, data);
		},
		onMarket: (err, json) => {
			if (err) {
				log.error("Native market callback reported an error", { error: err });
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(json);
			} catch (e) {
				log.warn("Failed to parse native market payload", {
					error: e,
					length: typeof json === "string" ? json.length : null,
				});
				return;
			}
			emitter.emit("market", parsed);
		},
	};
}

/**
 * Runs `onSuccess` once a native call has succeeded. Native streamer methods are async (they
 * return a Promise), but the synchronous wrappers cannot await them without changing their
 * return type; a rejection is therefore logged (instead of surfacing as an unhandled
 * rejection) and `onSuccess` is NOT run. A non-thenable result counts as immediate success.
 * A synchronous throw from the native call propagates before this helper is reached.
 */
export function afterNativeSuccess(
	result: unknown,
	onSuccess: () => void,
	log: StrictLogger,
	operation: string,
): void {
	if (
		result !== null &&
		typeof result === "object" &&
		typeof (result as PromiseLike<unknown>).then === "function"
	) {
		(result as PromiseLike<unknown>).then(onSuccess, (error: unknown) => {
			log.error(`Native ${operation} failed`, { error });
		});
		return;
	}
	onSuccess();
}
