// =============================================
// FILE: ts-core/src/retrieve/RequestUnlimited.ts
// PURPOSE: High-resilience HTTP request utility using ky for requests with retries, error handling, and serialization.
// Supports single or parallel requests with discriminated union results for safe typing.
// =============================================
import { deepmergeCustom } from "deepmerge-ts";
import ky, { HTTPError } from "ky";
import { serializeError } from "serialize-error";
import { serializeResponse, } from "./RequestResponseSerialize";
/**
 * Custom deepmerge instance that overwrites arrays instead of merging them.
 * This matches the previous ts-deepmerge { mergeArrays: false } behavior.
 */
const customDeepmerge = deepmergeCustom({
    mergeArrays: false,
});
/**
 * Default configuration for ky requests, including retry logic and hooks.
 */
export const DEFAULT_REQUEST_OPTIONS = {
    timeout: 50000,
    throwHttpErrors: true,
    retry: {
        limit: 5,
        methods: ["get", "post", "put", "delete", "patch"],
        backoffLimit: 3000,
        shouldRetry: ({ error, retryCount }) => {
            if (error instanceof HTTPError && error.response) {
                const status = error.response.status;
                if (status === 429 && retryCount <= 5)
                    return true;
                if (status >= 400 && status < 500)
                    return false;
                return status >= 500;
            }
            return true;
        },
    },
    method: "get",
    headers: {
        "content-type": "application/json",
        accept: "application/json",
    },
    hooks: {
        beforeRetry: [
            async ({ retryCount }) => {
                const logger = globalThis.logger;
                logger?.trace(`Retrying API call, retry count: ${retryCount}`);
            },
        ],
    },
};
/**
 * Internal utility to normalize header keys to lowercase for consistency.
 * @param obj - The headers object to normalize.
 * @returns Normalized headers with lowercase keys.
 */
function toLowercaseKeys(obj) {
    const newObj = {};
    for (const key in obj) {
        if (Object.hasOwn(obj, key) && obj[key] !== undefined) {
            newObj[key.toLowerCase()] = obj[key];
        }
    }
    return newObj;
}
/**
 * Makes an HTTP request to a single URL with resilience features.
 * @param url - The URL or Request object to fetch.
 * @param options - Optional ky configuration to override defaults.
 * @returns A Promise resolving to the RequestResult (success or error).
 * @template T - The expected response body type.
 */
export async function endPoint(url, options = {}) {
    // 1. Normalize headers
    const normalizedDefaultHeaders = toLowercaseKeys((DEFAULT_REQUEST_OPTIONS.headers || {}));
    const normalizedInputHeaders = options.headers
        ? toLowercaseKeys(options.headers)
        : {};
    // 2. Separate headers and hooks from options to handle them manually
    const { headers, hooks, ...remainingOptions } = options;
    // 3. Construct final options.
    // Manually concat hooks to ensure default 'beforeRetry' is preserved.
    const kyOptions = customDeepmerge(DEFAULT_REQUEST_OPTIONS, remainingOptions, {
        headers: { ...normalizedDefaultHeaders, ...normalizedInputHeaders },
        hooks: {
            beforeRetry: [
                ...(DEFAULT_REQUEST_OPTIONS.hooks?.beforeRetry || []),
                ...(hooks?.beforeRetry || []),
            ],
        },
    });
    try {
        const responseObject = await ky(url, kyOptions);
        const response = await serializeResponse(responseObject);
        return {
            status: "success",
            value: response,
        };
    }
    catch (error) {
        // @ts-expect-error - ky error property
        if (error instanceof HTTPError || error.response) {
            const errorResponse = await serializeResponse(
            // @ts-expect-error - ky error property
            error.response);
            const logger = globalThis.logger;
            logger?.warn("RequestUnlimited: HTTP Error", {
                status: errorResponse?.status,
                url: url.toString(),
            });
            return {
                status: "error",
                reason: errorResponse,
            };
        }
        const serializedError = serializeError(error);
        const logger = globalThis.logger;
        logger?.error("RequestUnlimited: Internal/Network Error", serializedError);
        return {
            status: "error",
            reason: serializedError,
        };
    }
}
/**
 * Makes parallel HTTP requests to multiple URLs.
 * @param urls - Array of URLs or Request objects to fetch.
 * @param options - Optional ky configuration to apply to all requests.
 * @returns A Promise resolving to an array of RequestResults (in input order).
 * @template T - The expected response body type for each request.
 */
export async function endPoints(urls, options = {}) {
    const promises = urls.map((url) => endPoint(url, options));
    const results = await Promise.allSettled(promises);
    return results.map((result) => {
        if (result.status === "fulfilled")
            return result.value;
        return {
            status: "error",
            reason: serializeError(result.reason),
        };
    });
}
/**
 * @deprecated Use endPoint/endPoints functions directly.
 */
export const RequestUnlimited = {
    defaults: DEFAULT_REQUEST_OPTIONS,
    endPoint,
    endPoints,
};
