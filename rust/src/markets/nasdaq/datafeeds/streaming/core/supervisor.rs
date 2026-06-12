//! Owns the reconnect loop for a ProviderDriver. Single place for backoff/state.
use tokio::sync::mpsc;
use crate::markets::nasdaq::datafeeds::streaming::core::driver::{AttemptOutcome, ProviderDriver};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::MarketEvent;

/// Drive `driver` across reconnects until Fatal/Stopped. Sends events to `tx`.
#[allow(dead_code)] // spawned by the host in Task 8
pub async fn run_supervisor<D: ProviderDriver>(
    driver: D,
    symbols: Vec<String>,
    tx: mpsc::Sender<MarketEvent>,
    mut sub_rx: mpsc::Receiver<Vec<String>>,
    mut stop_rx: mpsc::Receiver<()>,
    policy: ReconnectPolicy,
) {
    if driver.validate().is_err() { return; }
    let mut attempt: u32 = 0;
    loop {
        let outcome = driver.connect_once(&symbols, &tx, &mut sub_rx, &mut stop_rx).await;
        match outcome {
            AttemptOutcome::Stopped | AttemptOutcome::Fatal(_) => break,
            AttemptOutcome::ConnectedThenDropped => { attempt = 0; }      // healthy drop → reset
            AttemptOutcome::NeverConnected => { attempt = attempt.saturating_add(1); }
        }
        if let Some(max) = policy.max_retries { if attempt > max { break; } }
        let delay = policy.next_delay(attempt);
        tokio::select! {
            _ = stop_rx.recv() => break,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}
