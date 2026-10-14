import { Cron } from "croner";
import logger from "../loggers";

/** Parses every expression once (throws synchronously on an invalid one) and returns the matcher. */
function compile(
	includeExprs: string[],
	excludeExprs: string[],
	timezone?: string,
): (now: Date) => boolean {
	const opts = timezone ? { timezone } : {};
	const build = (exprs: string[]) => exprs.map((e) => new Cron(e, opts));
	const include = build(includeExprs);
	const exclude = build(excludeExprs);
	// croner's match(): `nextRun(now)` is the NEXT occurrence and is never null for a recurring
	// expression, so it cannot answer "does this match now".
	return (now) =>
		include.some((c) => c.match(now)) && !exclude.some((c) => c.match(now));
}

/**
 * True when ANY include expression matches `now` and NO exclude expression does.
 * Throws if an expression is invalid.
 */
export function shouldRunNow(
	includeExprs: string[],
	excludeExprs: string[],
	now: Date,
	timezone?: string,
): boolean {
	return compile(includeExprs, excludeExprs, timezone)(now);
}

/**
 * Run a handler when ANY include cron matches AND
 * NONE of the exclude crons match.
 *
 * Supports 6-field cron expressions (seconds). The expressions are validated and compiled once, so an
 * invalid one throws here rather than inside the timer. The schedule is polled every second against
 * the wall clock: a second skipped by a stalled event loop is not replayed, and a handler that takes
 * longer than a second can overlap with the next run.
 *
 * A handler that throws (or returns a rejected promise) does not stop the job or crash the process:
 * the error goes to `onError`, or is logged when none is given.
 *
 * @param timezone - Optional IANA timezone name (e.g. "America/New_York").
 *   Pattern matching uses the wall-clock time in that zone.
 *   Defaults to the local system timezone when omitted.
 */
export function includeExcludeCron(
	includeExprs: string[],
	excludeExprs: string[],
	handler: () => void,
	timezone?: string,
	onError?: (error: unknown) => void,
) {
	const shouldRun = compile(includeExprs, excludeExprs, timezone);
	const report =
		onError ??
		((error: unknown) =>
			logger.error("includeExcludeCron: handler failed", { error }));

	// Tick every second so we can evaluate second-level rules
	const job = new Cron("* * * * * *", () => {
		if (!shouldRun(new Date())) return;
		try {
			const result: unknown = handler();
			if (result instanceof Promise) result.catch(report);
		} catch (error) {
			report(error);
		}
	});

	return job;
}
