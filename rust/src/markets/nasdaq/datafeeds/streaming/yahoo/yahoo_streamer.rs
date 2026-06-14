// =============================================
// FILE: rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs
// PURPOSE: Thin N-API facade for the Yahoo Finance real-time data stream.
// DESCRIPTION: Delegates all websocket/reconnect/persistence work to the shared
// `WebsocketStreamerHost` + `YahooDriver`. Dual-mode: emits the byte-identical raw
// `JsPricingData` via `on_pricing` AND the unified (finstream-superset) `MarketEvent`
// as JSON via the optional `on_market_event` callback. Single-channel (bare-symbol)
// subscriptions persisted in redb (the single source of truth for resume).
// =============================================

use crate::markets::nasdaq::datafeeds::streaming::core::host::{
    unique_db_path, WebsocketStreamerHost,
};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use crate::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_driver::YahooDriver;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;

/// Bounded TSFN (Epic 5 ffi-tsfn-queue-unbounded): caps the off-heap queue at 4096; NonBlocking
/// delivery drops on overflow. Used for the high-rate market-data callbacks only.
type BoundedTsfn<T> = ThreadsafeFunction<T, Unknown<'static>, T, Status, true, false, 4096>;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

pub use crate::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_streaming_proto_handler::JsPricingData;

/// Configuration parameters for the Yahoo price streamer. Yahoo has no credentials; `db_path`
/// and `base_url` are retained for API/back-compat and test injection.
#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct YahooConfig {
    /// Legacy no-op: the redb path is derived per-instance by the host (or via the `YAHOO_DB`
    /// env override). Retained for back-compat; ignored.
    pub db_path: Option<String>,
    /// Threshold in seconds for silence detection before triggering a reconnect (default 60).
    pub silence_seconds: Option<u32>,
    /// Optional override for the WebSocket URL (defaults to the Yahoo v2 streamer).
    pub base_url: Option<String>,
}

/// Represents a single log entry formatted for the Corelib StrictLogger.
#[napi(object)]
#[derive(Clone, Debug, serde::Serialize)]
pub struct LogRecord {
    /// The log level (e.g., "info", "error", "trace").
    pub level: String,
    /// The primary log message.
    pub msg: String,
    /// Optional structured data serialized as a JSON string.
    pub extras: Option<String>,
}

/// Represents a lifecycle event emitted by the streamer.
#[napi(object)]
#[derive(Clone, Debug, serde::Serialize)]
pub struct EventRecord {
    /// The type of event (e.g., "connected", "disconnected", "reconnecting", "error").
    pub r#type: String,
    /// Optional metadata or error message associated with the event.
    pub data: Option<String>,
}

/// Interior mutable state for `YahooStreaming`.
struct YahooInner {
    host: WebsocketStreamerHost,
    config: YahooConfig,
    started: bool,
}

impl YahooConfig {
    fn default_empty() -> Self {
        Self {
            db_path: None,
            silence_seconds: None,
            base_url: None,
        }
    }
}

/// N-API facade for Yahoo real-time streaming (dual-mode: raw + unified).
///
/// `ThreadsafeFunction` is not `Clone`; each is wrapped in `Arc` so the pump closure can hold a
/// cheap reference-counted copy. `on_market_event` is optional (absent ⇒ raw-only consumers).
#[napi]
pub struct YahooStreaming {
    inner: Arc<Mutex<YahooInner>>,
    on_log: Arc<ThreadsafeFunction<LogRecord>>,
    on_pricing: Arc<BoundedTsfn<JsPricingData>>,
    on_event: Arc<ThreadsafeFunction<EventRecord>>,
    on_market_event: Option<Arc<BoundedTsfn<String>>>,
}

#[napi]
impl YahooStreaming {
    /// Constructs a new `YahooStreaming` with the JS callback functions.
    /// Order: (on_log, on_pricing, on_event, [on_market_event]). `on_market_event` is optional —
    /// pass it to also receive the unified `"market"` stream.
    #[napi(constructor)]
    pub fn new(
        on_log: ThreadsafeFunction<LogRecord>,
        on_pricing: ThreadsafeFunction<JsPricingData, Unknown<'static>, JsPricingData, Status, true, false, 4096>,
        on_event: ThreadsafeFunction<EventRecord>,
        on_market_event: Option<ThreadsafeFunction<String, Unknown<'static>, String, Status, true, false, 4096>>,
    ) -> napi::Result<Self> {
        let host = WebsocketStreamerHost::new(
            unique_db_path("yahoo_streaming", "YAHOO_DB"),
            "yahoo_subscriptions",
            "yahoo".into(),
            ProviderKind::Yahoo,
        )
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(YahooInner {
                host,
                config: YahooConfig::default_empty(),
                started: false,
            })),
            on_log: Arc::new(on_log),
            on_pricing: Arc::new(on_pricing),
            on_event: Arc::new(on_event),
            on_market_event: on_market_event.map(Arc::new),
        })
    }

    /// Set config (silence threshold / optional base_url override).
    #[napi]
    pub async fn init(&self, config: YahooConfig) -> Result<()> {
        self.inner.lock().await.config = config;
        Ok(())
    }

    /// Start streaming; the driver resumes persisted subscriptions (redb) on every (re)connect.
    #[napi]
    pub async fn start(&self) -> Result<()> {
        let mut g = self.inner.lock().await;
        if g.started {
            return Ok(());
        }
        let driver = YahooDriver {
            name: "yahoo".into(),
            base_url: g.config.base_url.clone(),
            silence_seconds: g.config.silence_seconds.unwrap_or(60),
            db: g.host.db_handle(),
            table: g.host.table_name(),
        };
        let on_pricing = Arc::clone(&self.on_pricing);
        let on_event = Arc::clone(&self.on_event);
        let on_market = self.on_market_event.clone();
        g.host.start(
            driver,
            Vec::new(),
            ReconnectPolicy {
                jitter: true,
                ..Default::default()
            },
            move |ev: CoreEvent| match ev {
                CoreEvent::Pricing {
                    raw: RawPricing::Yahoo(p),
                    uni,
                } => {
                    let _ = on_pricing.call(Ok(p), ThreadsafeFunctionCallMode::NonBlocking);
                    if let Some(cb) = on_market.as_ref() {
                        for u in &uni {
                            if let Ok(j) = serde_json::to_string(u) {
                                let _ = cb.call(Ok(j), ThreadsafeFunctionCallMode::NonBlocking);
                            }
                        }
                    }
                }
                CoreEvent::Status(status) => {
                    let (t, d) = match status {
                        ProviderStatus::Connected { .. } => ("connected".to_string(), None),
                        ProviderStatus::Disconnected { reason, .. } => {
                            ("disconnected".to_string(), Some(reason))
                        }
                        ProviderStatus::Reconnecting {
                            attempt, delay_ms, ..
                        } => (
                            "reconnecting".to_string(),
                            Some(format!("attempt {attempt}, {delay_ms}ms")),
                        ),
                        ProviderStatus::Error { message, .. } => {
                            ("error".to_string(), Some(message))
                        }
                    };
                    let _ = on_event.call(
                        Ok(EventRecord { r#type: t, data: d }),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
                // RawPricing::Alpaca / ::Finnhub never reach the Yahoo pump.
                _ => {}
            },
        );
        let _ = self.on_log.call(
            Ok(LogRecord {
                level: "debug".into(),
                msg: "yahoo start".into(),
                extras: None,
            }),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        g.started = true;
        Ok(())
    }

    /// Subscribe to additional symbols (bare list; persisted to redb + sent live to the driver).
    #[napi]
    pub async fn subscribe(&self, symbols: Vec<String>) -> Result<()> {
        self.inner.lock().await.host.subscribe(symbols).await;
        Ok(())
    }

    /// Remove `symbols` from the persisted set (so they don't resume on restart).
    #[napi]
    pub async fn unsubscribe(&self, symbols: Vec<String>) -> Result<()> {
        self.inner.lock().await.host.unsubscribe(symbols).await;
        Ok(())
    }

    /// Clears all persisted subscriptions and stops the stream.
    #[napi]
    pub async fn clean(&self) -> Result<()> {
        let mut g = self.inner.lock().await;
        let _ = g.host.delete_subscriptions_table();
        if let Some(tx) = g.host.stop_tx.take() {
            let _ = tx.try_send(());
        }
        g.started = false;
        Ok(())
    }

    /// Gracefully stops the streaming supervisor (keeps persisted subscriptions for resume).
    #[napi]
    pub async fn stop(&self) -> Result<()> {
        let mut g = self.inner.lock().await;
        if let Some(tx) = g.host.stop_tx.take() {
            let _ = tx.try_send(());
        }
        g.started = false;
        Ok(())
    }
}

#[cfg(test)]
mod facade_tests {
    use crate::markets::nasdaq::datafeeds::streaming::core::host::{
        unique_db_path, WebsocketStreamerHost,
    };
    use crate::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;

    fn fresh_host() -> WebsocketStreamerHost {
        WebsocketStreamerHost::new(
            unique_db_path("yahoo_streaming", "YAHOO_DB_TEST_UNSET"),
            "yahoo_subscriptions",
            "yahoo".into(),
            ProviderKind::Yahoo,
        )
        .expect("test host")
    }

    #[tokio::test]
    async fn subscribe_persists_bare_keys_and_resumes() {
        let host = fresh_host();
        host.subscribe(vec!["AAPL".into(), "BTC-USD".into()]).await;
        let mut got = host.get_persisted_subscriptions();
        got.sort();
        assert_eq!(got, vec!["AAPL".to_string(), "BTC-USD".to_string()]);
    }

    #[tokio::test]
    async fn unsubscribe_removes_persisted_key() {
        let host = fresh_host();
        host.subscribe(vec!["AAPL".into(), "MSFT".into()]).await;
        host.unsubscribe(vec!["AAPL".into()]).await;
        assert_eq!(host.get_persisted_subscriptions(), vec!["MSFT".to_string()]);
    }
}
