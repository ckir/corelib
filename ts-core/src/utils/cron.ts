import { Cron } from "croner";

/**
 * Run a handler when ANY include cron matches AND
 * NONE of the exclude crons match.
 *
 * Supports 6-field cron expressions (seconds).
 */
export function includeExcludeCron(
  includeExprs: string[],
  excludeExprs: string[],
  handler: () => void
) {
  // Tick every second so we can evaluate second-level rules
  const job = new Cron("* * * * * *", () => {
    const now = new Date();

    // Check if ANY include cron matches "now"
    const included = includeExprs.some(expr => {
      const c = new Cron(expr);
      return c.nextRun(now) === null; // null = matches now
    });

    if (!included) return;

    // Check if ANY exclude cron matches "now"
    const excluded = excludeExprs.some(expr => {
      const c = new Cron(expr);
      return c.nextRun(now) === null;
    });

    if (!excluded) {
      handler();
    }
  });

  return job;
}
