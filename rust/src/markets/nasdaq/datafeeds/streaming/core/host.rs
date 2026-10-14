//! Generic FFI coordination host shared by all provider facades.
use crate::markets::nasdaq::datafeeds::streaming::core::driver::{ProviderDriver, SubRequest};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::supervisor::run_supervisor;
use crate::markets::nasdaq::datafeeds::streaming::core::types::CoreEvent;
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

static INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Channel tag used by the single-channel `subscribe()` path. Single-channel drivers (Finnhub)
/// ignore it; it exists only so the live `SubRequest` is well-formed.
const DEFAULT_SUB_CHANNEL: &str = "default";

/// Paths minted by `unique_db_path` (i.e. NOT user-supplied). A host opened on one of these owns
/// the file and deletes it on `Drop`; a host opened on any other path leaves its file alone.
static AUTO_PATHS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Resolve the redb path for a streamer instance.
///
/// * If `env_override` (e.g. `YAHOO_DB` / `ALPACA_DB`) is set, that path is returned and treated as
///   EXPLICIT: it is kept on `Drop`, so persisted subscriptions survive restarts.
/// * Otherwise a unique `{prefix}_{pid}_{seq}_{nanos}.redb` under `temp_dir` is returned (b-1: no
///   shared-file lock). It is EPHEMERAL: the host deletes it on `Drop`. Persistence across process
///   restarts therefore REQUIRES the explicit env var.
pub fn unique_db_path(prefix: &str, env_override: &str) -> PathBuf {
    if let Ok(p) = std::env::var(env_override) {
        return PathBuf::from(p);
    }
    let pid = std::process::id();
    let seq = INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}_{pid}_{seq}_{nanos}.redb"));
    if let Ok(mut g) = AUTO_PATHS.lock() {
        g.get_or_insert_with(HashSet::new).insert(path.clone());
    }
    path
}

/// Claim ownership of an auto-generated path (returns true once; explicit paths return false).
fn take_auto_path(path: &std::path::Path) -> bool {
    AUTO_PATHS
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().map(|set| set.remove(path)))
        .unwrap_or(false)
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
    /// Set when the redb file was auto-generated (not explicit): deleted on `Drop`.
    owned_db_path: Option<PathBuf>,
}

#[derive(Debug)]
pub enum HostError {
    DbOpen(redb::DatabaseError),
    /// A redb write (begin/open/insert/remove/commit) or its blocking task failed.
    Persist(String),
    /// The driver's `validate()` rejected its configuration (e.g. missing API key).
    Validation(String),
}
impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostError::DbOpen(e) => write!(f, "failed to open redb: {e}"),
            HostError::Persist(e) => write!(f, "failed to persist subscriptions: {e}"),
            HostError::Validation(e) => write!(f, "invalid streamer configuration: {e}"),
        }
    }
}
impl std::error::Error for HostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            HostError::DbOpen(e) => Some(e),
            HostError::Persist(_) | HostError::Validation(_) => None,
        }
    }
}

/// Map a CoreEvent to a short static kind string for hot-path tracing (REDACTION:
/// kind only — never the raw pricing payload).
fn core_event_kind(ev: &CoreEvent) -> &'static str {
    match ev {
        CoreEvent::Pricing { .. } => "pricing",
        CoreEvent::Status(_) => "status",
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
        let owned = take_auto_path(&db_path);
        let db = match Database::create(&db_path) {
            Ok(db) => Arc::new(db),
            Err(e) => {
                if owned {
                    let _ = std::fs::remove_file(&db_path);
                }
                return Err(HostError::DbOpen(e));
            }
        };
        Ok(Self {
            db,
            table,
            source,
            provider,
            sub_tx: None,
            stop_tx: None,
            monitor_task: None,
            pump_task: None,
            owned_db_path: owned.then_some(db_path),
        })
    }

    /// True while the supervisor monitor task is alive. After the supervisor ends on its own
    /// (Fatal, max_retries, panic) this turns false, so facades can allow a fresh `start()`.
    pub fn is_running(&self) -> bool {
        self.monitor_task.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// Run one blocking redb write transaction off the async workers; errors are propagated.
    async fn write_keys(&self, keys: Vec<String>, insert: bool) -> Result<(), HostError> {
        let db = Arc::clone(&self.db);
        let table = self.table;
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let def: TableDefinition<&str, bool> = TableDefinition::new(table);
            let wtx = db.begin_write().map_err(|e| e.to_string())?;
            {
                let mut t = wtx.open_table(def).map_err(|e| e.to_string())?;
                for k in &keys {
                    if insert {
                        t.insert(k.as_str(), true).map_err(|e| e.to_string())?;
                    } else {
                        t.remove(k.as_str()).map_err(|e| e.to_string())?;
                    }
                }
            }
            wtx.commit().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| HostError::Persist(e.to_string()))?
        .map_err(HostError::Persist)
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
    /// Returns `Err(HostError::Validation)` WITHOUT spawning anything if `driver.validate()` fails,
    /// so the facade can surface the misconfiguration to JS instead of failing silently.
    pub fn start<D, P>(
        &mut self,
        driver: D,
        symbols: Vec<String>,
        policy: ReconnectPolicy,
        mut on_event_pump: P,
    ) -> Result<(), HostError>
    where
        D: ProviderDriver,
        P: FnMut(CoreEvent) + Send + 'static,
    {
        driver.validate().map_err(HostError::Validation)?;
        let (tx, mut rx) = mpsc::channel::<CoreEvent>(1024);
        let (sub_tx, sub_rx) = mpsc::channel::<SubRequest>(64);
        let (stop_tx, stop_rx) = mpsc::channel::<()>(1);
        self.sub_tx = Some(sub_tx);
        self.stop_tx = Some(stop_tx);

        // b-1 §3.4: monitor awaits the supervisor; on panic emit a synthetic Error event via a tx clone.
        // CoreEvent::Status carries the provider tag (not source), so the monitor only needs `provider`.
        let monitor_tx = tx.clone();
        let provider = self.provider; // ProviderKind is Copy — generic, not hardcoded

        let sup = tokio::spawn(run_supervisor(
            driver,
            symbols,
            tx,
            sub_rx,
            stop_rx,
            policy,
            self.provider,
        ));

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
                tracing::trace!(target: "corelib_rust::stream::tick", kind = core_event_kind(&ev), "pump event");
                on_event_pump(ev);
            }
        }));
        Ok(())
    }

    /// Persist + push a subscription set to the live driver. A failed persist returns `Err`
    /// (nothing is sent live).
    pub async fn subscribe(&self, symbols: Vec<String>) -> Result<(), HostError> {
        self.write_keys(symbols.clone(), true).await?;
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
        Ok(())
    }

    /// Remove `symbols` from the persisted subscription set so they do not resurrect on restart.
    /// (Phase 1: live WS-unsubscribe through the driver is deferred to Phase 2; this keeps redb
    /// consistent with developer intent — agy convergent 🟢.)
    pub async fn unsubscribe(&self, symbols: Vec<String>) -> Result<(), HostError> {
        self.write_keys(symbols, false).await
    }

    /// Write `channel:symbol` composite keys (multi-channel providers).
    #[allow(dead_code)] // consumed by Alpaca in Tasks 7/8
    pub async fn subscribe_channel(
        &self,
        channel: &str,
        symbols: Vec<String>,
    ) -> Result<(), HostError> {
        let keys = symbols.iter().map(|s| format!("{channel}:{s}")).collect();
        self.write_keys(keys, true).await
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
    pub async fn unsubscribe_channel(
        &self,
        channel: &str,
        symbols: Vec<String>,
    ) -> Result<(), HostError> {
        let keys = symbols.iter().map(|s| format!("{channel}:{s}")).collect();
        self.write_keys(keys, false).await
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
        // Auto-generated (ephemeral) redb files are removed; explicit paths are kept. Best-effort:
        // on Windows the file may still be open via a driver's Arc<Database> clone.
        if let Some(p) = self.owned_db_path.take() {
            let _ = std::fs::remove_file(p);
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
        h.subscribe_channel("quotes", vec!["AAPL".into(), "MSFT".into()])
            .await
            .unwrap();
        h.subscribe_channel("trades", vec!["AAPL".into()])
            .await
            .unwrap();
        let mut q = h.get_persisted_subscriptions_for_channel("quotes", "quotes");
        q.sort();
        assert_eq!(q, vec!["AAPL".to_string(), "MSFT".to_string()]);
        assert_eq!(
            h.get_persisted_subscriptions_for_channel("trades", "quotes"),
            vec!["AAPL".to_string()]
        );
        h.unsubscribe_channel("quotes", vec!["AAPL".into()])
            .await
            .unwrap();
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
        h.subscribe(vec!["TSLA".into()]).await.unwrap(); // writes "TSLA" (bare) through the legacy path
        let got = h.get_persisted_subscriptions_for_channel("quotes", "quotes");
        assert!(got.contains(&"TSLA".to_string()));
    }
    #[tokio::test]
    async fn delete_subscriptions_table_clears_all() {
        let h = fresh();
        h.subscribe_channel("quotes", vec!["AAPL".into()])
            .await
            .unwrap();
        h.delete_subscriptions_table().unwrap();
        assert!(h
            .get_persisted_subscriptions_for_channel("quotes", "quotes")
            .is_empty());
    }
}

#[cfg(test)]
mod flight_tests {
    use super::core_event_kind;
    use crate::markets::nasdaq::datafeeds::streaming::core::schema::{
        ProviderKind, ProviderStatus,
    };
    use crate::markets::nasdaq::datafeeds::streaming::core::types::{
        AlpacaPricingData, CoreEvent, RawPricing,
    };
    use crate::observability::ring_buffer::{drain_to_lines, reset_for_test};

    #[test]
    fn core_event_kind_maps_variants() {
        let pricing = CoreEvent::Pricing {
            raw: RawPricing::Alpaca(AlpacaPricingData {
                symbol: "AAPL".into(),
                message_type: "quote".into(),
                price: 1.0,
                bid_price: 1.0,
                ask_price: 2.0,
                volume: 3.0,
                timestamp: "t".into(),
            }),
            uni: vec![],
        };
        let status = CoreEvent::Status(ProviderStatus::Connected {
            provider: ProviderKind::Alpaca,
        });
        assert_eq!(core_event_kind(&pricing), "pricing");
        assert_eq!(core_event_kind(&status), "status");
    }

    #[test]
    fn lifecycle_debug_is_captured_in_ring() {
        reset_for_test();
        crate::observability::init_flight_recorder();
        tracing::debug!(target: "corelib_rust::stream", attempt = 1u32, "connect");
        let lines = drain_to_lines();
        assert!(lines
            .iter()
            .any(|l| l.contains("connect") && l.contains("attempt")));
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::driver::AttemptOutcome;
    use futures_util::future::{BoxFuture, FutureExt};
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    /// Driver whose single attempt ends Fatal immediately (supervisor exits on its own).
    struct FatalDriver {
        valid: bool,
        attempts: Arc<AtomicUsize>,
    }
    impl ProviderDriver for FatalDriver {
        fn validate(&self) -> Result<(), String> {
            if self.valid {
                Ok(())
            } else {
                Err("key required".into())
            }
        }
        fn connect_once<'a>(
            &'a self,
            _: &'a [String],
            _: &'a mpsc::Sender<CoreEvent>,
            _: &'a mut mpsc::Receiver<SubRequest>,
            _: &'a mut mpsc::Receiver<()>,
        ) -> BoxFuture<'a, AttemptOutcome> {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            async { AttemptOutcome::Fatal("boom".into()) }.boxed()
        }
    }

    fn host(env: &str) -> WebsocketStreamerHost {
        WebsocketStreamerHost::new(
            unique_db_path("test_lifecycle", env),
            "test_subscriptions",
            "test".into(),
            ProviderKind::Alpaca,
        )
        .expect("host")
    }

    #[tokio::test]
    async fn start_with_invalid_driver_returns_err_and_spawns_nothing() {
        let mut h = host("TEST_LIFECYCLE_UNSET");
        let attempts = Arc::new(AtomicUsize::new(0));
        let r = h.start(
            FatalDriver {
                valid: false,
                attempts: Arc::clone(&attempts),
            },
            vec![],
            ReconnectPolicy::default(),
            |_| {},
        );
        assert!(matches!(r, Err(HostError::Validation(ref m)) if m == "key required"));
        assert!(!h.is_running());
        assert!(h.stop_tx.is_none() && h.monitor_task.is_none());
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn finished_supervisor_is_not_running_and_start_can_respawn() {
        let mut h = host("TEST_LIFECYCLE_UNSET");
        let attempts = Arc::new(AtomicUsize::new(0));
        for round in 1..=2usize {
            h.start(
                FatalDriver {
                    valid: true,
                    attempts: Arc::clone(&attempts),
                },
                vec![],
                ReconnectPolicy::default(),
                |_| {},
            )
            .unwrap();
            // Fatal => supervisor + monitor end on their own; is_running must flip to false.
            tokio::time::timeout(Duration::from_secs(5), async {
                while h.is_running() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("monitor should finish after Fatal");
            assert_eq!(attempts.load(Ordering::SeqCst), round);
        }
    }

    #[tokio::test]
    async fn auto_path_removed_on_drop_explicit_path_kept() {
        // auto-generated: removed
        let auto = unique_db_path("test_cleanup", "TEST_CLEANUP_DB_UNSET");
        let h = WebsocketStreamerHost::new(auto.clone(), "t", "t".into(), ProviderKind::Alpaca)
            .unwrap();
        assert!(auto.exists());
        drop(h);
        assert!(
            !auto.exists(),
            "auto-generated redb must be deleted on drop"
        );

        // explicit (not minted by unique_db_path): kept
        let explicit = std::env::temp_dir().join(format!(
            "test_explicit_{}_{}.redb",
            std::process::id(),
            INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let h = WebsocketStreamerHost::new(explicit.clone(), "t", "t".into(), ProviderKind::Alpaca)
            .unwrap();
        drop(h);
        assert!(explicit.exists(), "explicit redb must survive drop");
        let _ = std::fs::remove_file(&explicit);
    }

    #[tokio::test]
    async fn env_override_path_is_kept_on_drop() {
        let p = std::env::temp_dir().join(format!("test_envdb_{}.redb", std::process::id()));
        std::env::set_var("TEST_HOST_ENV_DB_SET", &p);
        let path = unique_db_path("x", "TEST_HOST_ENV_DB_SET");
        std::env::remove_var("TEST_HOST_ENV_DB_SET");
        assert_eq!(path, p);
        let h = WebsocketStreamerHost::new(path, "t", "t".into(), ProviderKind::Alpaca).unwrap();
        drop(h);
        assert!(p.exists());
        let _ = std::fs::remove_file(&p);
    }

    #[tokio::test]
    async fn persist_failure_is_propagated() {
        let h = host("TEST_LIFECYCLE_UNSET");
        // A table defined with a different key/value type makes open_table fail inside the txn.
        {
            let w = h.db.begin_write().unwrap();
            {
                let wrong: TableDefinition<u64, u64> = TableDefinition::new("test_subscriptions");
                let _ = w.open_table(wrong).unwrap();
            }
            w.commit().unwrap();
        }
        let r = h.subscribe(vec!["AAPL".into()]).await;
        assert!(matches!(r, Err(HostError::Persist(_))), "got {r:?}");
        assert!(matches!(
            h.subscribe_channel("trades", vec!["AAPL".into()]).await,
            Err(HostError::Persist(_))
        ));
        assert!(matches!(
            h.unsubscribe(vec!["AAPL".into()]).await,
            Err(HostError::Persist(_))
        ));
    }
}
