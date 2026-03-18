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
import {
	type RequestResult,
	endPoint as unlimitedEndPoint,
	endPoints as unlimitedEndPoints,
} from "./RequestUnlimited";

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

			const logger = globalThis.logger;
			const msg = `[RequestProxied] Proxy removed (3 consecutive failures): ${proxyBase}`;
			logger?.warn(msg, {
				proxy: proxyBase,
			});
			console.log(msg);
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
		if (this.activeProxies.length === 0) {
			const logger = globalThis.logger;
			logger?.error("[RequestProxied] No active proxies left");
			return {
				status: "error",
				reason: { message: "No active proxies left" } as any,
			};
		}

		let attempts = 0;
		const _startIndex = this.currentIndex;
		const targetStr =
			typeof url === "string"
				? url
				: url instanceof URL
					? url.toString()
					: url.url;

		while (attempts < this.activeProxies.length) {
			const proxyBase =
				this.activeProxies[this.currentIndex % this.activeProxies.length];
			const proxyUrl = this.buildProxyUrl(proxyBase, suffix, targetStr);

			// Advance rotation on EVERY attempt (success or failure) as requested
			this.currentIndex = (this.currentIndex + 1) % this.activeProxies.length;

			const result = await unlimitedEndPoint<T>(proxyUrl, options);

			if (result.status === "success") {
				this.trackSuccess(proxyBase);
				return result;
			}

			// Failure path
			this.trackFailure(proxyBase);
			attempts++;
		}

		// All proxies failed
		const logger = globalThis.logger;
		logger?.error("[RequestProxied] All proxies failed", {
			originalUrl: targetStr,
		});
		return {
			status: "error",
			reason: { message: "All proxies failed" } as any,
		};
	}

	/**
	 * Makes parallel proxied requests with explicit round-robin load balancing.
	 *
	 * Each original URL is assigned to a proxy via round-robin.
	 * The constructed proxy URLs are then passed to RequestUnlimited.endPoints (parallelism + retries handled there).
	 *
	 * Note: failure tracking / auto-removal is currently only implemented for endPoint().
	 *       endPoints uses the current activeProxies snapshot at call time.
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
		if (this.activeProxies.length === 0 || urls.length === 0) {
			return urls.map(() => ({
				status: "error",
				reason: { message: "No active proxies" } as any,
			}));
		}

		// Explicit round-robin distribution
		const proxyUrls: string[] = [];
		for (let i = 0; i < urls.length; i++) {
			const proxyBase = this.activeProxies[i % this.activeProxies.length];
			const target = urls[i];
			const targetStr =
				typeof target === "string"
					? target
					: target instanceof URL
						? target.toString()
						: target.url;

			proxyUrls.push(this.buildProxyUrl(proxyBase, suffix, targetStr));
		}

		// Delegate parallelism, retries, and result handling to RequestUnlimited
		return await unlimitedEndPoints<T>(proxyUrls, options);
	}
}
