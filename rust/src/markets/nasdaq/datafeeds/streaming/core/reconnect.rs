//! Exponential-backoff reconnection policy with std-derived jitter.
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct ReconnectPolicy {
    pub max_retries: Option<u32>,
    pub max_duration: Option<Duration>,
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub jitter: bool,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self {
            max_retries: None,
            max_duration: Some(Duration::from_secs(3600)),
            initial_delay: Duration::from_secs(5),
            max_delay: Duration::from_secs(3600),
            jitter: false,
        }
    }
}

impl ReconnectPolicy {
    /// Delay for a 0-based attempt: initial * 2^attempt, capped at max_delay,
    /// optionally jittered to 0.5..=1.0x, floored at 100ms.
    pub fn next_delay(&self, attempt: u32) -> Duration {
        let base = self.initial_delay.as_secs_f64() * 2_f64.powi(attempt as i32);
        let capped = base.min(self.max_delay.as_secs_f64());
        let final_secs = if self.jitter {
            // std-derived pseudo-jitter (no `rand` dependency): factor in 0.5..=1.0
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos() as f64;
            let factor = 0.5 + (nanos / 1_000_000_000.0) * 0.5; // 0.5..1.0
            capped * factor
        } else {
            capped
        };
        Duration::from_secs_f64(final_secs.max(0.1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grows_exponentially_and_caps() {
        let p = ReconnectPolicy { initial_delay: Duration::from_secs(5), max_delay: Duration::from_secs(60), jitter: false, ..Default::default() };
        assert_eq!(p.next_delay(0), Duration::from_secs(5));
        assert_eq!(p.next_delay(1), Duration::from_secs(10));
        assert_eq!(p.next_delay(2), Duration::from_secs(20));
        assert_eq!(p.next_delay(10), Duration::from_secs(60)); // capped
    }
    #[test]
    fn jitter_stays_in_half_to_full_range() {
        let p = ReconnectPolicy { initial_delay: Duration::from_secs(10), max_delay: Duration::from_secs(60), jitter: true, ..Default::default() };
        let d = p.next_delay(0).as_secs_f64();
        assert!(d >= 5.0 && d <= 10.0, "jittered delay {d} out of 0.5..1.0x range");
    }
    #[test]
    fn floors_at_100ms() {
        let p = ReconnectPolicy { initial_delay: Duration::from_millis(1), max_delay: Duration::from_secs(60), jitter: false, ..Default::default() };
        assert!(p.next_delay(0) >= Duration::from_millis(100));
    }
}
