// =============================================
// FILE: rust/src/utils/include_exclude_cron.rs
// PURPOSE: Dedicated file for the include/exclude cron helper
// (moved out of utils.rs to follow the request).
// Exact behavioural mirror of ts-core/src/utils/cron.ts.
// =============================================

use chrono::{DateTime, Duration, Utc};
use cron::Schedule;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration as StdDuration;

/// Handle returned by `include_exclude_cron`.
///
/// Allows the caller to gracefully stop the background cron thread.
/// The thread will exit on the next tick after `stop()` is called.
pub struct CronJobHandle {
    stop_flag: Arc<AtomicBool>,
}

impl CronJobHandle {
    /// Stops the cron job. The background thread will exit cleanly on the next tick.
    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::Relaxed);
    }
}

/// Creates and starts a background cron job that ticks every second.
///
/// The provided `handler` is executed **only** when:
/// - **ANY** of the `include_exprs` matches the current time, **AND**
/// - **NONE** of the `exclude_exprs` matches the current time.
///
/// - Crons are pre-parsed once for maximum performance.
/// - Supports second-level precision (7-field cron format).
/// - Runs in a dedicated `std::thread` (no Tokio or async runtime required).
/// - Returns a `CronJobHandle` that can be used to stop the job.
///
/// # Panics
/// Panics (with a clear message) if any cron expression is invalid – same behaviour as the TS version.
pub fn include_exclude_cron<F>(
    include_exprs: Vec<String>,
    exclude_exprs: Vec<String>,
    handler: F,
) -> CronJobHandle
where
    F: Fn() + Send + Sync + 'static,
{
    let handler = Arc::new(handler);

    // Pre-parse all include crons (fast path)
    let include_schedules: Vec<Schedule> = include_exprs
        .into_iter()
        .map(|expr| {
            Schedule::from_str(&expr).expect("invalid include cron expression")
        })
        .collect();

    // Pre-parse all exclude crons
    let exclude_schedules: Vec<Schedule> = exclude_exprs
        .into_iter()
        .map(|expr| {
            Schedule::from_str(&expr).expect("invalid exclude cron expression")
        })
        .collect();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = Arc::clone(&stop_flag);
    let handler_clone = Arc::clone(&handler);

    // Background tick thread
    thread::spawn(move || {
        loop {
            if stop_flag_clone.load(Ordering::Relaxed) {
                break;
            }

            let now: DateTime<Utc> = Utc::now();

            // ANY include matches?
            let included = include_schedules.iter().any(|schedule| {
                let test_time = now - Duration::seconds(1);
                let mut upcoming = schedule.after(&test_time);
                upcoming.next().is_some_and(|next| next <= now + Duration::seconds(1))
            });

            if !included {
                thread::sleep(StdDuration::from_secs(1));
                continue;
            }

            // ANY exclude matches?
            let excluded = exclude_schedules.iter().any(|schedule| {
                let test_time = now - Duration::seconds(1);
                let mut upcoming = schedule.after(&test_time);
                upcoming.next().is_some_and(|next| next <= now + Duration::seconds(1))
            });

            if !excluded {
                (handler_clone)();
            }

            thread::sleep(StdDuration::from_secs(1));
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

        let handle = include_exclude_cron(
            vec!["* * * * * * *".to_string()],
            vec![],
            move || {
                c.fetch_add(1, Ordering::SeqCst);
            },
        );

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
    fn only_specific_second_include_works() {
        let counter = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&counter);

        // Fixed: correct 7-field cron that fires when second == 0
        // (every minute at xx:xx:00)
        let handle = include_exclude_cron(
            vec!["0 * * * * * *".to_string()],
            vec![],
            move || {
                c.fetch_add(1, Ordering::SeqCst);
            },
        );

        thread::sleep(Duration::from_secs(65)); // long enough to guarantee at least one hit
        handle.stop();

        let calls = counter.load(Ordering::SeqCst);
        assert!(calls >= 1, "Should have fired at least once when second == 0");
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

        let handle = include_exclude_cron(
            vec!["* * * * * * *".to_string()],
            vec![],
            move || {
                c.fetch_add(1, Ordering::SeqCst);
            },
        );

        thread::sleep(Duration::from_secs(2));
        handle.stop();
        let before = counter.load(Ordering::SeqCst);

        thread::sleep(Duration::from_secs(3));
        assert_eq!(before, counter.load(Ordering::SeqCst));
    }

    #[test]
    #[should_panic(expected = "invalid include cron expression")]
    fn invalid_include_cron_panics() {
        let _ = include_exclude_cron(vec!["invalid".to_string()], vec![], || {});
    }

    #[test]
    #[should_panic(expected = "invalid exclude cron expression")]
    fn invalid_exclude_cron_panics() {
        let _ = include_exclude_cron(vec!["* * * * * * *".to_string()], vec!["bad".to_string()], || {});
    }
}
