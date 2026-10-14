// =============================================
// FILE: ts-core/src/retrieve/RequestProxied.ts
// PURPOSE: High-resilience proxied HTTP client with the exact same public API as RequestUnlimited.
// • Accepts an array of proxy base URLs in the constructor.
// • endPoint / endPoints accept an optional `suffix` (default "").
// • suffix + original URL are combined using the URL constructor (guarantees correct ? vs & for the ?url= param).
// • Uses RequestUnlimited internally for all actual requests (retries, serialization, logging, error handling are identical).
// • Single endPoint: round-robin rotation + full fallback to every other proxy before error.
// • endPoints: explicit round-robin load-balancing across proxies, then delegates parallelism to RequestUnlimited.endPoints.
// • Failed proxies are removed from the active list for the lifetime of the instance after 3 consecutive failures ("constantly fails" rule).
// • Fully documented, type-safe, Biome-compliant, and follows the exact style of RequestUnlimited.ts and the retrieve/ module.
// =============================================

import type { Options as KyOptions } from "ky";
import { serializeError } from "serialize-error";
import logger from "../loggers";
import { nextCid } from "../utils/flight-recorder";
import {
	type RequestResult,
	endPoint as unlimitedEndPoint,
	endPoints as unlimitedEndPoints,
} from "./RequestUnlimited";

const requestProxiedLogger = logger.child({ section: "RequestProxied" });

/** Gateway statuses that originate from the proxy rather than the target. */
const PROXY_GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * True when a failed result reflects a problem with the proxy itself: a
 * network-level error (no HTTP response) or a proxy-originated gateway status.
 * Other 4xx/5xx responses were produced by the target and say nothing about
 * proxy health.
 */
function isProxyFailure(result: RequestResult<unknown>): boolean {
	if (result.status === "success") return false;
	const reason = result.reason as { status?: unknown } | null | undefined;
	const httpStatus =
		reason && typeof reason.status === "number" ? reason.status : undefined;
	if (httpStatus === undefined) return true;
	return PROXY_GATEWAY_STATUSES.has(httpStatus);
}

/**
 * True when `suffix` stays on the proxy host. Absolute ("https://evil/") and
 * protocol-relative ("//evil", "/\\evil") suffixes would replace the proxy host
 * and send the request (with caller headers) elsewhere.
 */
function isSuffixAllowed(suffix: string): boolean {
	const base = "https://proxy.invalid/";
	try {
		return new URL(suffix, base).origin === new URL(base).origin;
	} catch {
		return false;
	}
}

/**
 * Proxied HTTP client with automatic rotation, fallback, and load-balancing.
 *
 * Public API is identical to RequestUnlimited (same return types, same Options merging, same discriminated union).
 * All heavy lifting (retries, serialization, logging, error handling) is delegated to RequestUnlimited.
 */
export class RequestProxied {
	private activeProxies: string[];
	private failureStreaks: Map<string, number> = new Map();
	private currentIndex = 0;

	/**
	 * @param proxies - Array of proxy base URLs (e.g. ["https://proxy1...", "https://proxy2..."]).
	 *                  At least one proxy is required. The array is cloned internally.
	 * @throws Error if no proxies are provided.
	 */
	constructor(proxies: string[]) {
		if (!Array.isArray(proxies) || proxies.length === 0) {
			throw new Error("RequestProxied: at least one proxy URL is required");
		}
		// Validate each proxy URL
		for (const proxy of proxies) {
			try {
				new URL(proxy);
			} catch {
				throw new Error(`RequestProxied: invalid proxy URL "${proxy}"`);
			}
		}
		this.activeProxies = [...proxies];
	}

	/**
	 * Builds the final proxy URL using the URL constructor.
	 * Guarantees correct query string handling (? vs &) and URL encoding of the original target.
	 */
	private buildProxyUrl(
		proxyBase: string,
		suffix: string = "",
		targetUrl: string | URL | Request,
	): string {
		// Ensure base ends with / so suffix path is appended correctly
		const baseWithSlash = proxyBase.endsWith("/") ? proxyBase : `${proxyBase}/`;
		const urlObj = new URL(suffix, baseWithSlash);

		const targetStr =
			typeof targetUrl === "string"
				? targetUrl
				: targetUrl instanceof URL
					? targetUrl.toString()
					: targetUrl.url;

		urlObj.searchParams.set("url", targetStr);
		return urlObj.toString();
	}

	/**
	 * Records a successful request for a proxy (resets failure streak).
	 */
	private trackSuccess(proxyBase: string): void {
		this.failureStreaks.set(proxyBase, 0);
	}

	/**
	 * Records a failure for a proxy.
	 * After 3 consecutive failures the proxy is permanently removed from the active list for this session.
	 */
	private trackFailure(proxyBase: string): void {
		const streak = (this.failureStreaks.get(proxyBase) ?? 0) + 1;
		this.failureStreaks.set(proxyBase, streak);

		if (streak >= 3) {
			// Remove permanently for this instance
			this.activeProxies = this.activeProxies.filter((p) => p !== proxyBase);
			this.failureStreaks.delete(proxyBase);

			// Prevent index out of bounds
			if (this.currentIndex >= this.activeProxies.length) {
				this.currentIndex = 0;
			}

			requestProxiedLogger.warn("Proxy removed after 3 consecutive failures", {
				proxy: proxyBase,
			});
		}
	}

	/**
	 * Makes a single proxied HTTP request with full fallback.
	 *
	 * @param url - Original target URL (same as RequestUnlimited).
	 * @param suffix - Optional path to append to the proxy base (default "").
	 * @param options - Ky options passed through to RequestUnlimited (headers, method, body, etc.).
	 */
	public async endPoint<T = unknown>(
		url: string | URL | Request,
		suffix: string = "",
		options: KyOptions = {},
	): Promise<RequestResult<T>> {
		if (!isSuffixAllowed(suffix)) {
			requestProxiedLogger.error(
				"Rejected proxy suffix that leaves the proxy host",
			);
			return {
				status: "error",
				reason: serializeError(new Error("Invalid proxy suffix")),
				cid: nextCid(),
			};
		}

		if (this.activeProxies.length === 0) {
			requestProxiedLogger.error("No active proxies left");
			return {
				status: "error",
				reason: serializeError(new Error("No active proxies left")),
				cid: nextCid(),
			};
		}

		// Snapshot (rotated to the current index) so proxies evicted mid-call do not
		// shrink the loop: every proxy active at call start is tried once.
		const start = this.currentIndex % this.activeProxies.length;
		const toTry = [
			...this.activeProxies.slice(start),
			...this.activeProxies.slice(0, start),
		];
		const targetStr =
			typeof url === "string"
				? url
				: url instanceof URL
					? url.toString()
					: url.url;

		for (const proxyBase of toTry) {
			if (!this.activeProxies.includes(proxyBase)) continue;
			const proxyUrl = this.buildProxyUrl(proxyBase, suffix, targetStr);

			// Advance rotation on EVERY attempt (success or failure) as requested
			this.currentIndex =
				(this.activeProxies.indexOf(proxyBase) + 1) % this.activeProxies.length;

			const result = await unlimitedEndPoint<T>(proxyUrl, options);

			if (result.status === "success") {
				this.trackSuccess(proxyBase);
				return result;
			}

			if (!isProxyFailure(result)) {
				// The target answered (e.g. 404): the proxy is healthy. Return as-is.
				this.trackSuccess(proxyBase);
				return result;
			}

			// Failure path
			this.trackFailure(proxyBase);
		}

		// All proxies failed
		requestProxiedLogger.error("All proxies failed", {
			originalUrl: targetStr,
		});
		return {
			status: "error",
			reason: serializeError(new Error("All proxies failed")),
			cid: nextCid(),
		};
	}

	/**
	 * Makes parallel proxied requests with explicit round-robin load balancing.
	 *
	 * Each original URL is assigned to a proxy via round-robin.
	 * The constructed proxy URLs are then passed to RequestUnlimited.endPoints (parallelism + retries handled there).
	 * Failure tracking / auto-removal is implemented per-proxy: after 3 consecutive failures a proxy is evicted.
	 *
	 * @param urls - Array of original target URLs.
	 * @param suffix - Optional suffix applied to every proxy (default "").
	 * @param options - Ky options applied to all requests.
	 */
	public async endPoints<T = unknown>(
		urls: (string | URL | Request)[],
		suffix: string = "",
		options: KyOptions = {},
	): Promise<RequestResult<T>[]> {
		if (!isSuffixAllowed(suffix)) {
			requestProxiedLogger.error(
				"Rejected proxy suffix that leaves the proxy host",
			);
			return urls.map(() => ({
				status: "error" as const,
				reason: serializeError(new Error("Invalid proxy suffix")),
				cid: nextCid(),
			}));
		}

		if (this.activeProxies.length === 0 || urls.length === 0) {
			return urls.map(() => {
				const noProxiesReason = serializeError(new Error("No active proxies"));
				return {
					status: "error" as const,
					reason: noProxiesReason,
					cid: nextCid(),
				};
			});
		}

		// Explicit round-robin distribution — track which proxy each URL maps to
		const proxyUrls: string[] = [];
		const proxyAssignments: string[] = []; // parallel array: proxyAssignments[i] = proxyBase used for proxyUrls[i]
		for (let i = 0; i < urls.length; i++) {
			const proxyBase = this.activeProxies[i % this.activeProxies.length];
			const target = urls[i];
			if (proxyBase === undefined || target === undefined) {
				// Unreachable: i < urls.length and activeProxies is non-empty here.
				throw new Error("RequestProxied: proxy/url index invariant broken");
			}
			const targetStr =
				typeof target === "string"
					? target
					: target instanceof URL
						? target.toString()
						: target.url;

			proxyUrls.push(this.buildProxyUrl(proxyBase, suffix, targetStr));
			proxyAssignments.push(proxyBase);
		}

		// Delegate parallelism, retries, and result handling to RequestUnlimited
		const results = await unlimitedEndPoints<T>(proxyUrls, options);

		// Track success/failure per proxy and evict after 3 consecutive failures
		for (let i = 0; i < results.length; i++) {
			const proxyBase = proxyAssignments[i];
			const result = results[i];
			if (proxyBase === undefined || result === undefined) continue; // unreachable: parallel arrays
			if (isProxyFailure(result)) {
				this.trackFailure(proxyBase);
			} else {
				this.trackSuccess(proxyBase);
			}
		}

		return results;
	}
}
