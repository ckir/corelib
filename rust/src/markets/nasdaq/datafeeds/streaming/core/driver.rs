//! The single-attempt provider driver contract. The supervisor owns the reconnect loop.
use tokio::sync::mpsc;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::MarketEvent;

/// Outcome of one connection attempt, used by the supervisor to decide the next action.
#[allow(dead_code)] // used by drivers/supervisor in later tasks
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptOutcome {
    /// Connected (authenticated/received data) then the socket dropped → reset backoff, retry.
    ConnectedThenDropped,
    /// Never connected/authenticated this attempt → grow backoff, retry.
    NeverConnected,
    /// Fatal error (e.g. auth rejected) → stop the supervisor.
    Fatal(String),
    /// Graceful stop requested via stop_rx → stop the supervisor.
    Stopped,
}

/// A self-contained driver for ONE financial data provider connection attempt.
///
/// `connect_once` returns a **`BoxFuture`** (not a bare `async fn`): a stable-Rust `async fn` in a
/// trait yields a future that is NOT guaranteed `Send`, so awaiting it inside the generic
/// `run_supervisor<D>` (Task 7) that is `tokio::spawn`-ed (Task 8) would FAIL to compile. `BoxFuture`
/// pins it as `Send` explicitly. *(agy plan-pass 🔴 [Structural].)*
#[allow(dead_code)] // used by drivers/supervisor in later tasks
pub trait ProviderDriver: Send + Sync + 'static {
    /// Validate config (keys present, etc.) before the first attempt.
    fn validate(&self) -> Result<(), String> { Ok(()) }

    /// Perform ONE connection attempt: connect, (auth), subscribe `symbols`, apply live
    /// `sub_rx` updates, push `MarketEvent`s to `tx` (including `Status::Connected` on success),
    /// and resolve when the socket drops, a fatal error occurs, or `stop_rx` fires.
    fn connect_once<'a>(
        &'a self,
        symbols: &'a [String],
        tx: &'a mpsc::Sender<MarketEvent>,
        sub_rx: &'a mut mpsc::Receiver<Vec<String>>,
        stop_rx: &'a mut mpsc::Receiver<()>,
    ) -> futures::future::BoxFuture<'a, AttemptOutcome>;
}
