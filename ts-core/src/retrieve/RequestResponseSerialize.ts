// =============================================
// FILE: ts-core/src/retrieve/RequestResponseSerialize.ts
// PURPOSE: Utility for serializing Fetch API Responses into a plain, transferable structure.
// Handles body parsing (JSON or text fallback) and error logging via global logger.
// =============================================

/**
 * Standardized structure for serialized HTTP responses.
 * @template T - The expected type of the body if parsed as JSON; otherwise falls back to string.
 */
export interface SerializedResponse<T = unknown> {
	ok: boolean;
	status: number;
	statusText: string;
	headers: Record<string, string>;
	url: string;
	redirected: boolean;
	type: string; // Fetch Response.type (e.g., 'basic', 'cors', 'error')
	body: T | string;
}

/**
 * Serializes a Fetch API Response object into a plain structure.
 * Attempts to parse the body as JSON if the Content-Type indicates it; otherwise, treats as text.
 * Falls back to raw text on JSON parse errors. Logs warnings if body reading fails.
 * @param response - The Response object to serialize (or null/undefined).
 * @returns A Promise resolving to the SerializedResponse or null if no response provided.
 * @template T - The expected type of the body if JSON-parsed.
 */
export async function serializeResponse<T = unknown>(
	response: Response | null | undefined,
): Promise<SerializedResponse<T> | null> {
	if (!response) return null;

	const headers: Record<string, string> = {};
	response.headers.forEach((v, k) => {
		headers[k.toLowerCase()] = v;
	});

	let body: unknown;
	const contentType = response.headers.get("content-type") || "";

	try {
		const rawText = await response.text();
		if (contentType.includes("application/json")) {
			try {
				body = JSON.parse(rawText);
			} catch {
				body = rawText;
			}
		} else {
			body = rawText;
		}
	} catch (error) {
		globalThis.logger?.warn("Failed to read response body", { error });
		body = "[Error reading body]";
	}

	return {
		ok: response.ok,
		status: response.status,
		statusText: response.statusText,
		headers,
		url: response.url,
		redirected: response.redirected,
		type: response.type,
		body: body as T | string,
	};
}

/**
 * @deprecated Use serializeResponse instead.
 */
export const RequestResponseSerialize = {
	serialize: serializeResponse,
};
