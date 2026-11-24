// =============================================
// FILE: rust/src/utils/include_exclude_cron.rs
// PURPOSE: Dedicated file for the include/exclude cron helper.
// DESCRIPTION: This module provides a thread-based cron scheduler that
// supports multiple inclusion and exclusion rules. It is an exact behavioral
// mirror of the `ts-core/src/utils/cron.ts` implementation.
// =============================================

use croner::parser::CronParser;
use croner::Cron;
use jiff::tz::TimeZone;
use jiff::Timestamp;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration as StdDuration;

/// A handle to a running background cron job.
///
/// This handle allows the caller to gracefully stop the background thread
/// responsible for ticking and executing the scheduled handler.
pub struct CronJobHandle {
    /// Atomic flag checked by the background thread on every tick.
    stop_flag: Arc<AtomicBool>,
}

impl CronJobHandle {
    /// Signals the background cron job to stop.
    ///
    /// The background thread will exit cleanly upon its next internal tick
    /// after this method is called.
    pub fn stop(&self) {
        // Set the atomic stop flag to true
        self.stop_flag.store(true, Ordering::Relaxed);
    }
}

/// Creates and starts a background cron job with complex scheduling rules.
///
/// The provided `handler` closure is executed every second **only if**:
/// 1. **Any** of the `include_exprs` cron patterns match the current time.
/// 2. **None** of the `exclude_exprs` cron patterns match the current time.
///
/// Features:
/// - Cron expressions are pre-parsed for performance.
/// - Supports 5-, 6- and 7-field patterns (second-level precision), mirroring
///   `ts-core/src/utils/cron.ts`: a 5-field pattern is read as having seconds `0`.
/// - Day-of-week uses the POSIX `0`-`7` numbering (`0` and `7` = Sunday), so
///   weekend rules such as `* * * * * 0,6 *` are accepted.
/// - Day-of-month and day-of-week combine with OR (Vixie default); prefix the
///   day-of-week field with `+` to require both.
/// - Runs in a dedicated native OS thread.
///
/// # Arguments
/// * `include_exprs` - A list of cron strings that trigger execution.
/// * `exclude_exprs` - A list of cron strings that prevent execution.
/// * `handler` - The closure to execute when scheduling rules are met.
///
/// # Returns
/// A `CronJobHandle` used to manage the lifecycle of the job.
///
/// # Errors
/// Returns `Err` (never panics) if any of the provided cron expressions is syntactically invalid.
/// A handler that panics is caught and logged; the schedule keeps running.
pub fn include_exclude_cron<F>(
    include_exprs: Vec<String>,
    exclude_exprs: Vec<String>,
    handler: F,
) -> Result<CronJobHandle, String>
where
    F: Fn() + Send + Sync + 'static,
{
    // Wrap the handler in an Arc for thread-safe shared access
    let handler = Arc::new(handler);

    // One parser for all expressions. `CronParser::new()` is croner's default
    // (seconds/year optional), which accepts 5-, 6- and 7-field patterns exactly
    // like the `ts-core` twin; POSIX day-of-week and Vixie OR for DOM+DOW follow
    // from the same defaults (`alternative_weekdays: false`, `dom_and_dow: false`).
    let parser = CronParser::new();

    let include_schedules = parse_rules(&include_exprs, "include", &parser)?;
    let exclude_schedules = parse_rules(&exclude_exprs, "exclude", &parser)?;

    // Initialize the thread-safe stop flag
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = Arc::clone(&stop_flag);
    let handler_clone = Arc::clone(&handler);

    // Spawn the background ticking thread
    thread::spawn(move || {
        // Track the timestamp of the last executed tick to prevent double-firing
        let mut last_fire_ts = 0;
        loop {
            // Check if the job has been requested to stop
            if stop_flag_clone.load(Ordering::Relaxed) {
                break;
            }

            let now = Timestamp::now();
            let now_ts = now.as_second();

            // Check if we've already processed this exact second
            if now_ts <= last_fire_ts {
                // Calculate sleep time until the start of the next second
                let next_sec_ts = last_fire_ts + 1;
                let next_sec = Timestamp::from_second(next_sec_ts).expect("invalid timestamp");
                let sleep_dur = next_sec - Timestamp::now();
                if sleep_dur > jiff::SignedDuration::ZERO {
                    // Sleep for the precise duration until the next second starts
                    thread::sleep(StdDuration::from_millis(sleep_dur.as_millis() as u64));
                } else {
                    // Fallback to a very short sleep if we missed the target
                    thread::sleep(StdDuration::from_millis(10));
                }
                continue;
            }

            // The reference time for cron matching: the exact start of this second.
            let test_time = TimeZone::UTC
                .to_datetime(Timestamp::from_second(now_ts).expect("invalid timestamp"));

            // Determine if the current time is "included" by any rule
            let included = include_schedules
                .iter()
                .any(|schedule| schedule.is_time_matching(&test_time).unwrap_or(false));

            if !included {
                // Not a match for inclusion, wait a short while before checking again
                thread::sleep(StdDuration::from_millis(100));
                continue;
            }

            // Determine if the current time is "excluded" by any rule
            let excluded = exclude_schedules
                .iter()
                .any(|schedule| schedule.is_time_matching(&test_time).unwrap_or(false));

            // If included and NOT excluded, execute the provided handler
            if !excluded {
                // A panicking handler must not kill the schedule thread silently.
                if let Err(payload) =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (handler_clone)()))
                {
                    let msg = payload
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| payload.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "non-string panic payload".to_string());
                    tracing::error!(target: "corelib_rust::cron", panic = %msg, "cron handler panicked; schedule continues");
                }
            }

            // Record this timestamp as the last fired second
            last_fire_ts = now_ts;
        }
    });

    Ok(CronJobHandle { stop_flag })
}

/// Parse every expression up front so an invalid pattern fails at startup instead
/// of inside the ticking thread. `kind` selects the error wording the caller
/// reports ("include" / "exclude"), which is what the tests assert on.
fn parse_rules(exprs: &[String], kind: &str, parser: &CronParser) -> Result<Vec<Cron>, String> {
    exprs
        .iter()
        .map(|expr| {
            parser
                .parse(expr)
                .map_err(|e| format!("invalid {kind} cron expression {expr:?}: {e}"))
        })
        .collect()
}

// =============================================
// EXHAUSTIVE TESTS
// =============================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn every_second_include_no_exclude_handler_is_called() {
        let counter = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&counter);

        let handle = include_exclude_cron(vec!["* * * * * * *".to_string()], vec![], move || {
            c.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        thread::sleep(Duration::from_secs(4));
        handle.stop();

        let calls = counter.load(Ordering::SeqCst);
        assert!((3..=5).contains(&calls));
    }

    #[test]
    fn exclude_blocks_execution() {
        let counter = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&counter);

        let handle = include_exclude_cron(
            vec!["* * * * * * *".to_string()],
            vec!["* * * * * * *".to_string()],
            move || {
                c.fetch_add(1, Ordering::SeqCst);
            },
        )
        .unwrap();

        thread::sleep(Duration::from_secs(3));
        handle.stop();

        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn fires_only_on_specific_seconds() {
        let counter = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&counter);

        // Fire every 2 seconds
        let handle = include_exclude_cron(vec!["*/2 * * * * * *".to_string()], vec![], move || {
            c.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        thread::sleep(Duration::from_secs(6));
        handle.stop();

        let calls = counter.load(Ordering::SeqCst);
        // In 6 seconds, every 2 seconds should fire ~3 times
        assert!(
            (2..=4).contains(&calls),
            "Should have fired ~3 times in 6 seconds (every 2s), got {}",
            calls
        );
    }

    #[test]
    fn empty_include_never_runs() {
        let counter = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&counter);

        let handle = include_exclude_cron(vec![], vec![], move || {
            c.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        thread::sleep(Duration::from_secs(3));
        handle.stop();

        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stop_prevents_further_execution() {
        let counter = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&counter);

        let handle = include_exclude_cron(vec!["* * * * * * *".to_string()], vec![], move || {
            c.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        // Wait until it has fired at least once so we know it's running
        let start = std::time::Instant::now();
        while counter.load(Ordering::SeqCst) == 0 && start.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(100));
        }

        assert!(
            counter.load(Ordering::SeqCst) > 0,
            "Cron should have fired at least once before stopping"
        );

        handle.stop();
        // Brief drain: allow any in-flight tick to complete before snapshotting.
        // Without this, a tick that started just before stop() can still increment
        // the counter, causing a spurious failure on slower/busy schedulers (macOS).
        thread::sleep(Duration::from_millis(200));
        let before = counter.load(Ordering::SeqCst);

        thread::sleep(Duration::from_secs(2));
        assert_eq!(
            before,
            counter.load(Ordering::SeqCst),
            "Counter should not increase after stop()"
        );
    }

    #[test]
    fn invalid_include_cron_returns_err() {
        let r = include_exclude_cron(vec!["invalid".to_string()], vec![], || {});
        assert!(r.err().unwrap().contains("invalid include cron expression"));
    }

    #[test]
    fn invalid_exclude_cron_returns_err() {
        let r = include_exclude_cron(
            vec!["* * * * * * *".to_string()],
            vec!["bad".to_string()],
            || {},
        );
        assert!(r.err().unwrap().contains("invalid exclude cron expression"));
    }

    #[test]
    fn panicking_handler_does_not_kill_the_schedule() {
        let counter = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&counter);
        let handle = include_exclude_cron(vec!["* * * * * * *".to_string()], vec![], move || {
            c.fetch_add(1, Ordering::SeqCst);
            panic!("handler boom");
        })
        .unwrap();
        thread::sleep(Duration::from_secs(4));
        handle.stop();
        // Every tick panics; the thread must have survived to tick several times.
        assert!(
            counter.load(Ordering::SeqCst) >= 3,
            "schedule died after the first panic: {}",
            counter.load(Ordering::SeqCst)
        );
    }

    // ── Grammar / semantics pinned by the croner migration ──────────────────
    // These go through `parse_rules`, i.e. the exact parser production uses.

    /// Parse `expr` exactly as production does and test it against a wall-clock instant.
    fn matches_at(expr: &str, dt: &str) -> bool {
        let rules = parse_rules(&[expr.to_string()], "include", &CronParser::new())
            .expect("test expression should parse");
        let at: jiff::civil::DateTime = dt.parse().expect("test datetime should parse");
        rules[0].is_time_matching(&at).unwrap_or(false)
    }

    #[test]
    fn day_of_week_uses_posix_numbering() {
        // 2026-11-22 is a Sunday, 11-23 a Monday, 11-24 a Tuesday, 11-28 a Saturday.
        assert!(
            matches_at("* * * * * 0 *", "2026-11-22T12:00:00"),
            "0 = Sunday"
        );
        assert!(
            matches_at("* * * * * 7 *", "2026-11-22T12:00:00"),
            "7 aliases Sunday"
        );
        assert!(
            matches_at("* * * * * 1 *", "2026-11-23T12:00:00"),
            "1 = Monday"
        );
        assert!(
            matches_at("* * * * * 6 *", "2026-11-28T12:00:00"),
            "6 = Saturday"
        );
        assert!(
            !matches_at("* * * * * 0 *", "2026-11-23T12:00:00"),
            "0 must not match a Monday"
        );
    }

    #[test]
    fn weekend_exclusion_expression_parses_and_matches() {
        // rust/README.md ships `--exclude "* * * * * 0,6 *"`. `cron` 0.16 rejected
        // this expression outright, so the documented example never ran.
        let weekend = "* * * * * 0,6 *";
        assert!(
            matches_at(weekend, "2026-11-22T12:00:00"),
            "Sunday excluded"
        );
        assert!(
            matches_at(weekend, "2026-11-28T12:00:00"),
            "Saturday excluded"
        );
        assert!(
            !matches_at(weekend, "2026-11-24T12:00:00"),
            "Tuesday not excluded"
        );
    }

    #[test]
    fn five_field_pattern_defaults_seconds_to_zero() {
        // 5-field mirrors ts-core (npm croner accepts 5/6/7 fields too).
        assert!(
            matches_at("* * * * *", "2026-11-24T12:00:00"),
            "second 0 matches"
        );
        assert!(
            !matches_at("* * * * *", "2026-11-24T12:00:30"),
            "seconds default to 0, so :30 must not match"
        );
        // 6- and 7-field forms stay accepted alongside it.
        assert!(matches_at("* * * * * * *", "2026-11-24T12:00:30"));
        assert!(matches_at("* * * * * 1 *", "2026-11-23T12:00:00"));
    }

    #[test]
    fn day_of_month_and_day_of_week_combine_with_or() {
        // Vixie OR: the 1st of any month OR any Monday (npm croner agrees: 14 hits).
        assert!(
            matches_at("0 0 0 1 * MON", "2026-11-02T00:00:00"),
            "Monday but not the 1st matches under OR"
        );
        assert!(
            matches_at("0 0 0 1 * MON", "2026-12-01T00:00:00"),
            "the 1st but not a Monday matches under OR"
        );
        assert!(
            !matches_at("0 0 0 1 * MON", "2026-11-24T00:00:00"),
            "neither the 1st nor a Monday must not match"
        );
    }

    #[test]
    fn plus_prefix_requires_both_day_of_month_and_day_of_week() {
        // `+` flips DOM+DOW from OR to AND. 2027-02-01 is a Monday that is the 1st.
        assert!(
            matches_at("0 0 0 1 * +MON", "2027-02-01T00:00:00"),
            "the 1st and a Monday matches under AND"
        );
        assert!(
            !matches_at("0 0 0 1 * +MON", "2026-11-02T00:00:00"),
            "Monday but not the 1st fails under AND"
        );
        assert!(
            !matches_at("0 0 0 1 * +MON", "2026-12-01T00:00:00"),
            "the 1st but not a Monday fails under AND"
        );
    }
}
