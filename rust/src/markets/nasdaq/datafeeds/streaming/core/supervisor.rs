//! Owns the reconnect loop for a ProviderDriver. Single place for backoff/state.
use crate::markets::nasdaq::datafeeds::streaming::core::driver::{
    AttemptOutcome, ProviderDriver, SubRequest,
};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::types::CoreEvent;
use tokio::sync::mpsc;

/// Map an attempt outcome to a short static discriminant for tracing (REDACTION:
/// never Debug-dump `Fatal(msg)` — `msg` is a server-controlled error string. The
/// human-readable reason is still delivered to JS via `ProviderStatus::Error`).
fn outcome_kind(o: &AttemptOutcome) -> &'static str {
    match o {
        AttemptOutcome::ConnectedThenDropped => "connected_then_dropped",
        AttemptOutcome::NeverConnected => "never_connected",
        AttemptOutcome::Fatal(_) => "fatal",
        AttemptOutcome::Stopped => "stopped",
    }
}

/// Drive `driver` across reconnects until Fatal/Stopped. Sends events to `tx`.
#[allow(dead_code)] // spawned by the host in Task 8
pub async fn run_supervisor<D: ProviderDriver>(
    driver: D,
    symbols: Vec<String>,
    tx: mpsc::Sender<CoreEvent>,
    mut sub_rx: mpsc::Receiver<SubRequest>,
    mut stop_rx: mpsc::Receiver<()>,
    policy: ReconnectPolicy,
    provider: ProviderKind,
) {
    if let Err(message) = driver.validate() {
        // Surface the misconfiguration instead of dying silently (JS sees an "error" event).
        tracing::warn!(target: "corelib_rust::stream", "driver validation failed");
        let _ = tx
            .send(CoreEvent::Status(ProviderStatus::Error {
                provider,
                message,
            }))
            .await;
        return;
    }
    let mut attempt: u32 = 0;
    loop {
        tracing::debug!(target: "corelib_rust::stream", attempt, "connect");
        let outcome = driver
            .connect_once(&symbols, &tx, &mut sub_rx, &mut stop_rx)
            .await;
        tracing::debug!(target: "corelib_rust::stream", attempt, outcome = outcome_kind(&outcome), "attempt done");
        match outcome {
            AttemptOutcome::Stopped | AttemptOutcome::Fatal(_) => break,
            AttemptOutcome::ConnectedThenDropped => {
                attempt = 0;
            } // healthy drop → reset
            AttemptOutcome::NeverConnected => {
                attempt = attempt.saturating_add(1);
            }
        }
        if let Some(max) = policy.max_retries {
            if attempt > max {
                break;
            }
        }
        let delay = policy.next_delay(attempt);
        tracing::debug!(target: "corelib_rust::stream", delay_ms = delay.as_millis() as u64, attempt, "reconnect backoff");
        tokio::select! {
            _ = stop_rx.recv() => break,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::future::{BoxFuture, FutureExt};

    struct Invalid;
    impl ProviderDriver for Invalid {
        fn validate(&self) -> Result<(), String> {
            Err("key required".into())
        }
        fn connect_once<'a>(
            &'a self,
            _: &'a [String],
            _: &'a mpsc::Sender<CoreEvent>,
            _: &'a mut mpsc::Receiver<SubRequest>,
            _: &'a mut mpsc::Receiver<()>,
        ) -> BoxFuture<'a, AttemptOutcome> {
            async { panic!("connect_once must not run after a failed validate") }.boxed()
        }
    }

    #[tokio::test]
    async fn failed_validate_emits_error_status_before_returning() {
        let (tx, mut rx) = mpsc::channel(4);
        let (_s, sub_rx) = mpsc::channel(1);
        let (_t, stop_rx) = mpsc::channel(1);
        run_supervisor(
            Invalid,
            vec![],
            tx,
            sub_rx,
            stop_rx,
            ReconnectPolicy::default(),
            ProviderKind::Alpaca,
        )
        .await;
        match rx.recv().await {
            Some(CoreEvent::Status(ProviderStatus::Error { provider, message })) => {
                assert_eq!(provider, ProviderKind::Alpaca);
                assert_eq!(message, "key required");
            }
            _ => panic!("expected Status::Error"),
        }
    }
}
