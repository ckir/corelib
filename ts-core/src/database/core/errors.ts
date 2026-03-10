import { serializeError } from "serialize-error";
import type { LibraryLogger } from "./types.js";

/**
 * Handles and logs database errors, returning a serialized error object.
 */
export function handleDbError(
	logger: LibraryLogger,
	message: string,
	error: unknown,
) {
	const serialized = serializeError(error);
	logger.error(message, { error: serialized });
	return serialized;
}
