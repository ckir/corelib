use crossbeam_queue::ArrayQueue;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// One captured tracing event, stored structured (formatted lazily at dump).
#[derive(Clone, Debug)]
pub struct FlightEvent {
    pub ts_ms: u128,
    pub level: &'static str,
    pub target: &'static str,
    pub message: String,
    /// Pre-collected `key=value ` pairs (kept short; never secrets).
    pub fields: String,
}

const CAPACITY: usize = 8192;
static RING: OnceLock<ArrayQueue<FlightEvent>> = OnceLock::new();

pub fn ring() -> &'static ArrayQueue<FlightEvent> {
    RING.get_or_init(|| ArrayQueue::new(CAPACITY))
}

/// Lock-free record. `force_push` overwrites the oldest entry when full
/// (ring semantics) and never blocks or poisons.
pub fn record(ev: FlightEvent) {
    ring().force_push(ev);
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Drain the ring oldest→newest into formatted lines (for dump). Empties the ring.
pub fn drain_to_lines() -> Vec<String> {
    let r = ring();
    let mut out = Vec::with_capacity(r.len());
    while let Some(ev) = r.pop() {
        out.push(format!(
            "{} [{}] {} {}{}",
            ev.ts_ms,
            ev.level,
            ev.target,
            ev.message,
            if ev.fields.is_empty() {
                String::new()
            } else {
                format!(" {}", ev.fields.trim_end())
            }
        ));
    }
    out
}

/// Test-only: empty the ring so ordered/parallel tests don't pollute each other.
#[cfg(test)]
pub fn reset_for_test() {
    while ring().pop().is_some() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn force_push_overwrites_oldest_and_drains_in_order() {
        // fill past capacity; oldest should be evicted
        for i in 0..(CAPACITY as u128 + 5) {
            record(FlightEvent {
                ts_ms: i,
                level: "TRACE",
                target: "t",
                message: format!("m{i}"),
                fields: String::new(),
            });
        }
        let lines = drain_to_lines();
        assert_eq!(lines.len(), CAPACITY);
        assert!(lines[0].contains("m5")); // first 5 evicted
        assert!(lines
            .last()
            .unwrap()
            .contains(&format!("m{}", CAPACITY + 4)));
        assert!(drain_to_lines().is_empty()); // drained
    }
}
