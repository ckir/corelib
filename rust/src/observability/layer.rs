use super::ring_buffer::{now_ms, record, FlightEvent};
use std::fmt::Write as _;
use std::sync::Once;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

struct FieldCollector { message: String, fields: String }
impl Visit for FieldCollector {
	fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
		if field.name() == "message" {
			let _ = write!(self.message, "{value:?}");
		} else {
			let _ = write!(self.fields, "{}={:?} ", field.name(), value);
		}
	}
}

fn level_str(l: &Level) -> &'static str {
	match *l {
		Level::TRACE => "TRACE", Level::DEBUG => "DEBUG", Level::INFO => "INFO",
		Level::WARN => "WARN", Level::ERROR => "ERROR",
	}
}

/// tracing Layer that captures every event into the lock-free ring buffer.
pub struct FlightLayer;
impl<S: Subscriber> Layer<S> for FlightLayer {
	fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
		let meta = event.metadata();
		let mut c = FieldCollector { message: String::new(), fields: String::new() };
		event.record(&mut c);
		record(FlightEvent {
			ts_ms: now_ms(),
			level: level_str(meta.level()),
			target: meta.target(), // &'static str — no allocation
			message: c.message,
			fields: c.fields,
		});
	}
}

static INIT: Once = Once::new();

/// Idempotent: installs the FlightLayer subscriber (+ EnvFilter) and a panic
/// hook that dumps the ring to stderr. Safe to call on every host start.
pub fn init_flight_recorder() {
	INIT.call_once(|| {
		// Default keeps the per-TICK firehose OFF (it lives under the distinct
		// `corelib_rust::stream::tick` target — see later task) so the ring isn't washed
		// out in ~1.6s under load; connect/reconnect/subscribe/error stay at debug
		// in the ring. Opt into ticks with CORELIB_LOG="corelib_rust::stream::tick=trace".
		let filter = EnvFilter::try_from_env("CORELIB_LOG")
			.unwrap_or_else(|_| EnvFilter::new("corelib_rust=trace,corelib_rust::stream::tick=off"));
		// try_init: don't panic if a global subscriber already exists (tests/host re-entry).
		let _ = tracing_subscriber::registry().with(filter).with(FlightLayer).try_init();
		install_panic_dump_hook();
	});
}

fn install_panic_dump_hook() {
	let prev = std::panic::take_hook();
	std::panic::set_hook(Box::new(move |info| {
		// Pop per-event straight to stderr (no Vec/batch built during unwind →
		// minimal alloc, can't OOM-double-panic). ArrayQueue can't poison → safe.
		use std::io::Write as _;
		let mut err = std::io::stderr().lock();
		let _ = writeln!(err, "--- corelib flight-log dump (panic) ---");
		let r = super::ring_buffer::ring();
		while let Some(ev) = r.pop() {
			let _ = writeln!(err, "[flight] {} [{}] {} {} {}", ev.ts_ms, ev.level, ev.target, ev.message, ev.fields);
		}
		let _ = err.flush();
		prev(info);
	}));
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn emitted_trace_event_lands_in_ring() {
		init_flight_recorder();
		tracing::trace!(target: "corelib_rust::flighttest", symbol = "AAPL", "pump event");
		let lines = super::super::ring_buffer::drain_to_lines();
		assert!(lines.iter().any(|l| l.contains("flighttest") && l.contains("pump event") && l.contains("symbol")));
	}
}
