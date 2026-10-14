import { Cron } from "croner";

/**
 * Run a handler when ANY include cron matches AND
 * NONE of the exclude crons match.
 *
 * Supports 6-field cron expressions (seconds).
 *
 * @param timezone - Optional IANA timezone name (e.g. "America/New_York").
 *   Pattern matching uses the wall-clock time in that zone.
 *   Defaults to the local system timezone when omitted.
 */
/**
 * True when ANY include expression matches `now` and NO exclude expression does.
 * Uses croner's `match()`; `nextRun(now)` is the NEXT occurrence and is never null for a recurring
 * expression, so it cannot answer "does this match now".
 */
export function shouldRunNow(
	includeExprs: string[],
	excludeExprs: string[],
	now: Date,
	timezone?: string,
): boolean {
	const opts = timezone ? { timezone } : {};
	const matches = (expr: string) => new Cron(expr, opts).match(now);
	return includeExprs.some(matches) && !excludeExprs.some(matches);
}

export function includeExcludeCron(
	includeExprs: string[],
	excludeExprs: string[],
	handler: () => void,
	timezone?: string,
) {
	// Tick every second so we can evaluate second-level rules
	const job = new Cron("* * * * * *", () => {
		if (shouldRunNow(includeExprs, excludeExprs, new Date(), timezone)) {
			handler();
		}
	});

	return job;
}
