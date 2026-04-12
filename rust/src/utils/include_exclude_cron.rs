// =============================================
// FILE: rust/src/utils/include_exclude_cron.rs
// PURPOSE: Dedicated file for the include/exclude cron helper.
// DESCRIPTION: This module provides a thread-based cron scheduler that
// supports multiple inclusion and exclusion rules. It is an exact behavioral
// mirror of the `ts-core/src/utils/cron.ts` implementation.
// =============================================

use chrono::{DateTime, Duration, Utc};
use cron::Schedule;
use std::str::FromStr;
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
/// - Supports 7-field cron format (second-level precision).
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
/// # Panics
/// Panics if any of the provided cron expressions are syntactically invalid.
pub fn include_exclude_cron<F>(
    include_exprs: Vec<String>,
    exclude_exprs: Vec<String>,
    handler: F,
) -> CronJobHandle
where
    F: Fn() + Send + Sync + 'static,
{
    // Wrap the handler in an Arc for thread-safe shared access
    let handler = Arc::new(handler);

    // Pre-parse all "include" cron expressions into Schedule objects
    let include_schedules: Vec<Schedule> = include_exprs
        .into_iter()
        .map(|expr| Schedule::from_str(&expr).expect("invalid include cron expression"))
        .collect();

    // Pre-parse all "exclude" cron expressions into Schedule objects
    let exclude_schedules: Vec<Schedule> = exclude_exprs
        .into_iter()
        .map(|expr| Schedule::from_str(&expr).expect("invalid exclude cron expression"))
        .collect();

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

            let now: DateTime<Utc> = Utc::now();
            let now_ts = now.timestamp();

            // Check if we've already processed this exact second
            if now_ts <= last_fire_ts {
                // Calculate sleep time until the start of the next second
                let next_sec_ts = last_fire_ts + 1;
                let next_sec = DateTime::from_timestamp(next_sec_ts, 0).expect("invalid timestamp");
                let sleep_dur = next_sec - Utc::now();
                if sleep_dur > Duration::zero() {
                    // Sleep for the precise duration until the next second starts
                    thread::sleep(StdDuration::from_millis(sleep_dur.num_milliseconds() as u64));
                } else {
                    // Fallback to a very short sleep if we missed the target
                    thread::sleep(StdDuration::from_millis(10));
                }
                continue;
            }

            // Define the reference time for cron matching (the exact start of this second)
            let test_time = now - Duration::seconds(1);

            // Determine if the current time is "included" by any rule
            let included = include_schedules.iter().any(|schedule| {
                let mut upcoming = schedule.after(&test_time);
                upcoming
                    .next()
                    .is_some_and(|next| next.timestamp() == now_ts)
            });

            if !included {
                // Not a match for inclusion, wait a short while before checking again
                thread::sleep(StdDuration::from_millis(100));
                continue;
            }

            // Determine if the current time is "excluded" by any rule
            let excluded = exclude_schedules.iter().any(|schedule| {
                let mut upcoming = schedule.after(&test_time);
                upcoming
                    .next()
                    .is_some_and(|next| next.timestamp() == now_ts)
            });

            // If included and NOT excluded, execute the provided handler
            if !excluded {
                (handler_clone)();
            }

            // Record this timestamp as the last fired second
            last_fire_ts = now_ts;
        }
    });

    CronJobHandle { stop_flag }
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
        });

        thread::sleep(Duration::from_secs(4));
        handle.stop();

        let calls = counter.load(Ordering::SeqCst);
        assert!(calls >= 3 && calls <= 5);
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
        );

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
        });

        thread::sleep(Duration::from_secs(6));
        handle.stop();

        let calls = counter.load(Ordering::SeqCst);
        // In 6 seconds, every 2 seconds should fire ~3 times
        assert!(
            calls >= 2 && calls <= 4,
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
        });

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
        });

        // Wait until it has fired at least once so we know it's running
        let start = std::time::Instant::now();
        while counter.load(Ordering::SeqCst) == 0 && start.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(100));
        }

        handle.stop();
        let before = counter.load(Ordering::SeqCst);
        assert!(
            before > 0,
            "Cron should have fired at least once before stopping"
        );

        thread::sleep(Duration::from_secs(2));
        assert_eq!(
            before,
            counter.load(Ordering::SeqCst),
            "Counter should not increase after stop()"
        );
    }

    #[test]
    #[should_panic(expected = "invalid include cron expression")]
    fn invalid_include_cron_panics() {
        let _ = include_exclude_cron(vec!["invalid".to_string()], vec![], || {});
    }

    #[test]
    #[should_panic(expected = "invalid exclude cron expression")]
    fn invalid_exclude_cron_panics() {
        let _ = include_exclude_cron(
            vec!["* * * * * * *".to_string()],
            vec!["bad".to_string()],
            || {},
        );
    }
}
