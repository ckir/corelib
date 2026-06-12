//! Generic FFI coordination host shared by all provider facades.
use crate::markets::nasdaq::datafeeds::streaming::core::driver::{ProviderDriver, SubRequest};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::supervisor::run_supervisor;
use crate::markets::nasdaq::datafeeds::streaming::core::types::CoreEvent;
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

static INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Channel tag used by the single-channel `subscribe()` path. Single-channel drivers (Finnhub)
/// ignore it; it exists only so the live `SubRequest` is well-formed.
const DEFAULT_SUB_CHANNEL: &str = "default";

/// Build a unique per-instance redb path under temp_dir (b-1: no shared-file lock).
pub fn unique_db_path(prefix: &str, env_override: &str) -> std::path::PathBuf {
    if let Ok(p) = std::env::var(env_override) {
        return std::path::PathBuf::from(p);
    }
    let pid = std::process::id();
    let seq = INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    std::env::temp_dir().join(format!("{prefix}_{pid}_{seq}_{nanos}.redb"))
}

/// Shared coordination state. `Pump` consumes MarketEvents and calls the provider's typed TSFNs.
/// Like the b-1 Alpaca fix, we store the *monitor* task (which owns/awaits the supervisor) and the
/// pump task; the supervisor itself exits via `stop_tx`.
pub struct WebsocketStreamerHost {
    pub(crate) db: Database,
    pub(crate) table: &'static str,
    #[allow(dead_code)] // retained for instance identification / future logging; events tag via ProviderKind
    pub(crate) source: String,
    pub(crate) provider: ProviderKind, // generic: NOT hardcoded (agy plan-pass 🔴) — used in panic events
    pub(crate) sub_tx: Option<mpsc::Sender<SubRequest>>,
    pub(crate) stop_tx: Option<mpsc::Sender<()>>,
    pub(crate) monitor_task: Option<JoinHandle<()>>,
    pub(crate) pump_task: Option<JoinHandle<()>>,
}

impl WebsocketStreamerHost {
    /// Open/create the per-instance redb file. `source` names the instance; `provider` tags events.
    pub fn new(
        db_path: std::path::PathBuf,
        table: &'static str,
        source: String,
        provider: ProviderKind,
    ) -> Self {
        let db = Database::create(&db_path).expect("Failed to open redb");
        Self {
            db,
            table,
            source,
            provider,
            sub_tx: None,
            stop_tx: None,
            monitor_task: None,
            pump_task: None,
        }
    }

    /// Load previously-persisted subscription tickers so a restarted instance resumes them
    /// (agy plan-pass 🔴 — without this, keeping redb buys nothing). Merge into `start`'s symbols.
    pub fn get_persisted_subscriptions(&self) -> Vec<String> {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        let mut subs = Vec::new();
        if let Ok(rtx) = self.db.begin_read() {
            if let Ok(t) = rtx.open_table(table) {
                let Ok(iter) = t.iter() else { return subs };
                for item in iter {
                    let Ok(entry) = item else { continue };
                    subs.push(entry.0.value().to_string());
                }
            }
        }
        subs
    }

    /// Start the supervisor (driving `driver`), a panic monitor, and a pump that forwards events.
    pub fn start<D, P>(
        &mut self,
        driver: D,
        symbols: Vec<String>,
        policy: ReconnectPolicy,
        mut on_event_pump: P,
    ) where
        D: ProviderDriver,
        P: FnMut(CoreEvent) + Send + 'static,
    {
        let (tx, mut rx) = mpsc::channel::<CoreEvent>(1024);
        let (sub_tx, sub_rx) = mpsc::channel::<SubRequest>(64);
        let (stop_tx, stop_rx) = mpsc::channel::<()>(1);
        self.sub_tx = Some(sub_tx);
        self.stop_tx = Some(stop_tx);

        // b-1 §3.4: monitor awaits the supervisor; on panic emit a synthetic Error event via a tx clone.
        // CoreEvent::Status carries the provider tag (not source), so the monitor only needs `provider`.
        let monitor_tx = tx.clone();
        let provider = self.provider; // ProviderKind is Copy — generic, not hardcoded

        let sup = tokio::spawn(run_supervisor(driver, symbols, tx, sub_rx, stop_rx, policy));

        self.monitor_task = Some(tokio::spawn(async move {
            if let Err(e) = sup.await {
                if e.is_panic() {
                    let _ = monitor_tx
                        .send(CoreEvent::Status(ProviderStatus::Error {
                            provider,
                            message: "supervisor task panicked; stream is dead".into(),
                        }))
                        .await;
                }
            }
        }));

        self.pump_task = Some(tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                on_event_pump(ev);
            }
        }));
    }

    /// Persist + push a subscription set to the live driver.
    pub async fn subscribe(&self, symbols: Vec<String>) {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        if let Ok(wtx) = self.db.begin_write() {
            if let Ok(mut t) = wtx.open_table(table) {
                for s in &symbols {
                    let _ = t.insert(s.as_str(), true);
                }
            }
            let _ = wtx.commit();
        }
        if let Some(tx) = &self.sub_tx {
            // Single-channel callers (Finnhub) persist bare keys and ignore the channel tag;
            // multi-channel providers (Alpaca, Task 4+) use `subscribe_channel` instead.
            let _ = tx
                .send(SubRequest {
                    channel: DEFAULT_SUB_CHANNEL.to_string(),
                    symbols,
                })
                .await;
        }
    }

    /// Remove `symbols` from the persisted subscription set so they do not resurrect on restart.
    /// (Phase 1: live WS-unsubscribe through the driver is deferred to Phase 2; this keeps redb
    /// consistent with developer intent — agy convergent 🟢.)
    pub async fn unsubscribe(&self, symbols: Vec<String>) {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        if let Ok(wtx) = self.db.begin_write() {
            if let Ok(mut t) = wtx.open_table(table) {
                for s in &symbols {
                    let _ = t.remove(s.as_str());
                }
            }
            let _ = wtx.commit();
        }
    }
}

impl Drop for WebsocketStreamerHost {
    fn drop(&mut self) {
        // Supervisor exits gracefully via stop_tx (mirrors b-1 Alpaca). Abort monitor + pump.
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.try_send(());
        }
        if let Some(t) = self.monitor_task.take() {
            t.abort(); // b-1: abort monitor task
        }
        if let Some(t) = self.pump_task.take() {
            t.abort(); // b-1: abort BOTH facade tasks
        }
    }
}
