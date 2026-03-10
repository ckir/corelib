/**
 * Utility to sleep for a given number of milliseconds.
 */
export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));
