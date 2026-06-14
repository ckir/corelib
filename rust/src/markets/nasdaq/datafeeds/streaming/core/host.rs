//! Generic FFI coordination host shared by all provider facades.
use crate::markets::nasdaq::datafeeds::streaming::core::driver::{ProviderDriver, SubRequest};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::supervisor::run_supervisor;
use crate::markets::nasdaq::datafeeds::streaming::core::types::CoreEvent;
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
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
    pub(crate) db: Arc<Database>,
    pub(crate) table: &'static str,
    #[allow(dead_code)]
    // retained for instance identification / future logging; events tag via ProviderKind
    pub(crate) source: String,
    pub(crate) provider: ProviderKind, // generic: NOT hardcoded (agy plan-pass 🔴) — used in panic events
    pub(crate) sub_tx: Option<mpsc::Sender<SubRequest>>,
    pub(crate) stop_tx: Option<mpsc::Sender<()>>,
    pub(crate) monitor_task: Option<JoinHandle<()>>,
    pub(crate) pump_task: Option<JoinHandle<()>>,
}

#[derive(Debug)]
pub enum HostError {
    DbOpen(redb::DatabaseError),
}
impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostError::DbOpen(e) => write!(f, "failed to open redb: {e}"),
        }
    }
}
impl std::error::Error for HostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            HostError::DbOpen(e) => Some(e),
        }
    }
}

impl WebsocketStreamerHost {
    /// Open/create the per-instance redb file. `source` names the instance; `provider` tags events.
    /// Fallible: returns `Err(HostError::DbOpen)` if redb cannot open the path (e.g. a shared path
    /// already held open by another instance) — callers must handle it instead of aborting.
    pub fn new(
        db_path: std::path::PathBuf,
        table: &'static str,
        source: String,
        provider: ProviderKind,
    ) -> Result<Self, HostError> {
        let db = Arc::new(Database::create(&db_path).map_err(HostError::DbOpen)?);
        Ok(Self {
            db,
            table,
            source,
            provider,
            sub_tx: None,
            stop_tx: None,
            monitor_task: None,
            pump_task: None,
        })
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

    /// Write `channel:symbol` composite keys (multi-channel providers).
    #[allow(dead_code)] // consumed by Alpaca in Tasks 7/8
    pub fn subscribe_channel(&self, channel: &str, symbols: Vec<String>) {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        if let Ok(wtx) = self.db.begin_write() {
            if let Ok(mut t) = wtx.open_table(table) {
                for s in &symbols {
                    let _ = t.insert(format!("{channel}:{s}").as_str(), true);
                }
            }
            let _ = wtx.commit();
        }
    }

    /// Send a live per-channel `SubRequest` to the running driver (immediate in-session effect).
    /// No-op before `start()` (when `sub_tx` is `None`): resume is still safe because the caller
    /// also persisted via `subscribe_channel`, and the driver reads redb fresh on every connect.
    #[allow(dead_code)] // consumed by Alpaca in Task 8
    pub fn subscribe_channel_live(&self, channel: &str, symbols: Vec<String>) {
        if let Some(tx) = &self.sub_tx {
            let _ = tx.try_send(SubRequest {
                channel: channel.to_string(),
                symbols,
            });
        }
    }

    /// Remove precise `channel:symbol` keys.
    #[allow(dead_code)] // consumed by Alpaca in Tasks 7/8
    pub fn unsubscribe_channel(&self, channel: &str, symbols: Vec<String>) {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        if let Ok(wtx) = self.db.begin_write() {
            if let Ok(mut t) = wtx.open_table(table) {
                for s in &symbols {
                    let _ = t.remove(format!("{channel}:{s}").as_str());
                }
            }
            let _ = wtx.commit();
        }
    }

    /// Read symbols for `target_channel`; a colon-less (legacy bare) key is treated as `default_channel`.
    #[allow(dead_code)] // consumed by Alpaca in Tasks 7/8
    pub fn get_persisted_subscriptions_for_channel(
        &self,
        target_channel: &str,
        default_channel: &str,
    ) -> Vec<String> {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        let mut out = Vec::new();
        if let Ok(rtx) = self.db.begin_read() {
            if let Ok(t) = rtx.open_table(table) {
                let Ok(iter) = t.iter() else { return out };
                for item in iter {
                    let Ok(entry) = item else { continue };
                    let key = entry.0.value().to_string();
                    let (ch, sym) = key
                        .split_once(':')
                        .unwrap_or((default_channel, key.as_str()));
                    if ch == target_channel {
                        out.push(sym.to_string());
                    }
                }
            }
        }
        out
    }

    /// Drop the entire subscriptions table (for `clean()`).
    #[allow(dead_code)] // consumed by Alpaca in Tasks 7/8
    pub fn delete_subscriptions_table(&self) -> Result<(), String> {
        let table: TableDefinition<&str, bool> = TableDefinition::new(self.table);
        let wtx = self.db.begin_write().map_err(|e| e.to_string())?;
        let _ = wtx.delete_table(table);
        wtx.commit().map_err(|e| e.to_string())
    }

    /// Cheap clone of the shared redb handle (drivers read persisted subscriptions directly).
    #[allow(dead_code)] // consumed by Alpaca in Tasks 7/8
    pub fn db_handle(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    /// The subscriptions table name (for driver-side reads).
    #[allow(dead_code)] // consumed by Alpaca in Tasks 7/8
    pub fn table_name(&self) -> &'static str {
        self.table
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

#[cfg(test)]
mod host_persistence_tests {
    use super::*;
    fn fresh() -> WebsocketStreamerHost {
        WebsocketStreamerHost::new(
            unique_db_path("test_host", "TEST_HOST_DB_UNSET"),
            "test_subscriptions",
            "test".into(),
            ProviderKind::Alpaca,
        )
        .expect("test host")
    }
    #[tokio::test]
    async fn channel_keys_roundtrip_and_unsubscribe_is_precise() {
        let h = fresh();
        h.subscribe_channel("quotes", vec!["AAPL".into(), "MSFT".into()]);
        h.subscribe_channel("trades", vec!["AAPL".into()]);
        let mut q = h.get_persisted_subscriptions_for_channel("quotes", "quotes");
        q.sort();
        assert_eq!(q, vec!["AAPL".to_string(), "MSFT".to_string()]);
        assert_eq!(
            h.get_persisted_subscriptions_for_channel("trades", "quotes"),
            vec!["AAPL".to_string()]
        );
        h.unsubscribe_channel("quotes", vec!["AAPL".into()]);
        assert_eq!(
            h.get_persisted_subscriptions_for_channel("quotes", "quotes"),
            vec!["MSFT".to_string()]
        );
        // trades:AAPL untouched
        assert_eq!(
            h.get_persisted_subscriptions_for_channel("trades", "quotes"),
            vec!["AAPL".to_string()]
        );
    }
    #[tokio::test]
    async fn colonless_legacy_key_defaults_to_channel() {
        let h = fresh();
        // simulate a legacy bare-symbol record via the existing API
        h.subscribe(vec!["TSLA".into()]).await; // writes "TSLA" (bare) through the legacy path
        let got = h.get_persisted_subscriptions_for_channel("quotes", "quotes");
        assert!(got.contains(&"TSLA".to_string()));
    }
    #[tokio::test]
    async fn delete_subscriptions_table_clears_all() {
        let h = fresh();
        h.subscribe_channel("quotes", vec!["AAPL".into()]);
        h.delete_subscriptions_table().unwrap();
        assert!(h
            .get_persisted_subscriptions_for_channel("quotes", "quotes")
            .is_empty());
    }
}
