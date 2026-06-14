// =============================================
// FILE: rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs
// PURPOSE: Thin N-API facade for the Alpaca real-time data stream.
// DESCRIPTION: Delegates all websocket/reconnect/persistence work to the shared
// `WebsocketStreamerHost` + `AlpacaDriver`. Dual-mode: emits the byte-identical raw
// `AlpacaPricingData` via `on_pricing` AND the unified (finstream-superset) `MarketEvent`
// as JSON via the optional `on_market_event` callback. Subscriptions are per-channel
// (trades/quotes/bars) and persisted in redb (the single source of truth for resume).
// =============================================

use crate::markets::nasdaq::datafeeds::streaming::alpaca::alpaca_driver::AlpacaDriver;
use crate::markets::nasdaq::datafeeds::streaming::core::host::{
    unique_db_path, WebsocketStreamerHost,
};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use crate::{EventRecord, LogRecord};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;

/// Bounded TSFN (Epic 5 ffi-tsfn-queue-unbounded): caps the off-heap queue at 1024; NonBlocking
/// delivery drops on overflow. Used for the high-rate market-data callbacks only.
type BoundedTsfn<T> = ThreadsafeFunction<T, Unknown<'static>, T, Status, true, false, 1024>;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

pub use crate::markets::nasdaq::datafeeds::streaming::core::types::AlpacaPricingData;

/// Configuration parameters for the Alpaca price streamer.
#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct AlpacaConfig {
    /// Legacy no-op: the redb path is now derived per-instance by the host (or via the
    /// `ALPACA_DB` env override). Retained for API/back-compat; ignored.
    pub db_path: Option<String>,
    /// Threshold in seconds for silence detection before triggering a reconnect (default 60).
    pub silence_seconds: Option<u32>,
    /// Optional override for the WebSocket URL (defaults to IEX stream or `APCA_API_BASE_URL`).
    pub base_url: Option<String>,
    /// Alpaca API Key ID. Falls back to `APCA_API_KEY_ID` environment variable.
    pub key_id: Option<String>,
    /// Alpaca API Secret Key. Falls back to `APCA_API_SECRET_KEY` environment variable.
    pub secret_key: Option<String>,
}

impl AlpacaConfig {
    /// An all-`None` config (used before `init` is called).
    fn default_empty() -> Self {
        Self {
            db_path: None,
            silence_seconds: None,
            base_url: None,
            key_id: None,
            secret_key: None,
        }
    }
}

/// Hand-written Debug impl that masks credential fields to prevent log leaks (b-1 §3.x).
impl std::fmt::Debug for AlpacaConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AlpacaConfig")
            .field("db_path", &self.db_path)
            .field("silence_seconds", &self.silence_seconds)
            .field("base_url", &self.base_url)
            .field("key_id", &self.key_id.as_ref().map(|_| "<redacted>"))
            .field(
                "secret_key",
                &self.secret_key.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// Per-channel subscription options. `subscribe`/`unsubscribe` accept any subset of channels.
#[napi(object)]
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct AlpacaSubscribeOpts {
    pub trades: Option<Vec<String>>,
    pub quotes: Option<Vec<String>>,
    pub bars: Option<Vec<String>>,
}

/// Interior mutable state for `AlpacaStreaming`.
struct AlpacaInner {
    host: WebsocketStreamerHost,
    config: AlpacaConfig,
    started: bool,
}

/// N-API facade for Alpaca real-time streaming (dual-mode: raw + unified).
///
/// `ThreadsafeFunction` is not `Clone`; each is wrapped in `Arc` so the pump closure can hold a
/// cheap reference-counted copy. `on_market_event` is optional (absent ⇒ raw-only consumers).
#[napi]
pub struct AlpacaStreaming {
    inner: Arc<Mutex<AlpacaInner>>,
    on_log: Arc<ThreadsafeFunction<LogRecord>>,
    on_pricing: Arc<BoundedTsfn<AlpacaPricingData>>,
    on_event: Arc<ThreadsafeFunction<EventRecord>>,
    on_market_event: Option<Arc<BoundedTsfn<String>>>,
}

#[napi]
impl AlpacaStreaming {
    /// Constructs a new `AlpacaStreaming` with the JS callback functions.
    /// Order: (on_log, on_pricing, on_event, [on_market_event]). `on_market_event` is optional —
    /// pass it to also receive the unified `"market"` stream.
    #[napi(constructor)]
    pub fn new(
        on_log: ThreadsafeFunction<LogRecord>,
        on_pricing: ThreadsafeFunction<
            AlpacaPricingData,
            Unknown<'static>,
            AlpacaPricingData,
            Status,
            true,
            false,
            1024,
        >,
        on_event: ThreadsafeFunction<EventRecord>,
        on_market_event: Option<
            ThreadsafeFunction<String, Unknown<'static>, String, Status, true, false, 1024>,
        >,
    ) -> napi::Result<Self> {
        let host = WebsocketStreamerHost::new(
            unique_db_path("alpaca_streaming", "ALPACA_DB"),
            "alpaca_subscriptions",
            "alpaca".into(),
            ProviderKind::Alpaca,
        )
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(AlpacaInner {
                host,
                config: AlpacaConfig::default_empty(),
                started: false,
            })),
            on_log: Arc::new(on_log),
            on_pricing: Arc::new(on_pricing),
            on_event: Arc::new(on_event),
            on_market_event: on_market_event.map(Arc::new),
        })
    }

    /// Set config (keys fall back to `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` env at `start`).
    #[napi]
    pub async fn init(&self, config: AlpacaConfig) -> Result<()> {
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
        let driver = AlpacaDriver {
            name: "alpaca".into(),
            base_url: g
                .config
                .base_url
                .clone()
                .or_else(|| std::env::var("APCA_API_BASE_URL").ok()),
            key_id: g
                .config
                .key_id
                .clone()
                .or_else(|| std::env::var("APCA_API_KEY_ID").ok())
                .unwrap_or_default(),
            secret_key: g
                .config
                .secret_key
                .clone()
                .or_else(|| std::env::var("APCA_API_SECRET_KEY").ok())
                .unwrap_or_default(),
            silence_seconds: g.config.silence_seconds.unwrap_or(60),
            db: g.host.db_handle(), // driver reads persisted subs from redb on every (re)connect
            table: g.host.table_name(),
        };
        // NOTE: do NOT pre-queue resume here — the driver reads the full persisted set from redb on
        // each connect (reconnect-safe). The facade's subscribe() persists to redb (so resume works)
        // and also sends a live SubRequest for immediate in-session effect.
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
                    raw: RawPricing::Alpaca(p),
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
                // RawPricing::Finnhub never reaches the Alpaca pump.
                _ => {}
            },
        );
        let _ = self.on_log.call(
            Ok(LogRecord {
                level: "debug".into(),
                msg: "alpaca start".into(),
                extras: None,
            }),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        g.started = true;
        Ok(())
    }

    /// Subscribe per channel. Each channel's symbols are persisted to redb (resume) AND sent live
    /// to the driver (immediate in-session effect).
    #[napi]
    pub async fn subscribe(&self, opts: AlpacaSubscribeOpts) -> Result<()> {
        let g = self.inner.lock().await;
        for (ch, syms) in [
            ("trades", opts.trades),
            ("quotes", opts.quotes),
            ("bars", opts.bars),
        ] {
            if let Some(s) = syms {
                if !s.is_empty() {
                    g.host.subscribe_channel(ch, s.clone());
                    g.host.subscribe_channel_live(ch, s);
                }
            }
        }
        Ok(())
    }

    /// Unsubscribe per channel (removes the persisted `channel:symbol` keys so they don't resume).
    #[napi]
    pub async fn unsubscribe(&self, opts: AlpacaSubscribeOpts) -> Result<()> {
        let g = self.inner.lock().await;
        for (ch, syms) in [
            ("trades", opts.trades),
            ("quotes", opts.quotes),
            ("bars", opts.bars),
        ] {
            if let Some(s) = syms {
                g.host.unsubscribe_channel(ch, s);
            }
        }
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

// =============================================
// TESTS
// =============================================

#[cfg(test)]
mod facade_tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::host::{
        unique_db_path, WebsocketStreamerHost,
    };
    use crate::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;

    fn fresh_host() -> WebsocketStreamerHost {
        WebsocketStreamerHost::new(
            unique_db_path("alpaca_streaming", "ALPACA_DB_TEST_UNSET"),
            "alpaca_subscriptions",
            "alpaca".into(),
            ProviderKind::Alpaca,
        )
        .expect("test host")
    }

    #[tokio::test]
    async fn subscribe_persists_per_channel_and_resumes() {
        // Build the host the same way the facade does and assert channel persistence/resume.
        let host = fresh_host();
        host.subscribe_channel("trades", vec!["AAPL".into()]);
        assert_eq!(
            host.get_persisted_subscriptions_for_channel("trades", "quotes"),
            vec!["AAPL".to_string()]
        );
        // A different channel is isolated.
        assert!(host
            .get_persisted_subscriptions_for_channel("quotes", "quotes")
            .is_empty());
    }

    #[test]
    fn alpaca_pricing_data_deserialization() {
        // The raw payload (re-exported from core::types) still round-trips from JSON.
        let raw_json = r#"{
            "symbol": "BRK-A",
            "message_type": "quote",
            "price": 600000.5,
            "bid_price": 600000.5,
            "ask_price": 600001.0,
            "volume": 100.0,
            "timestamp": "2026-03-15T15:00:00Z"
        }"#;
        let data: AlpacaPricingData =
            serde_json::from_str(raw_json).expect("Failed to parse AlpacaPricingData");
        assert_eq!(data.symbol, "BRK-A");
        assert_eq!(data.message_type, "quote");
        assert_eq!(data.price, 600000.5);
    }

    #[test]
    fn config_debug_masks_credentials() {
        let cfg = AlpacaConfig {
            db_path: None,
            silence_seconds: Some(60),
            base_url: None,
            key_id: Some("super-secret-key".into()),
            secret_key: Some("super-secret-secret".into()),
        };
        let dbg = format!("{cfg:?}");
        assert!(!dbg.contains("super-secret-key"));
        assert!(!dbg.contains("super-secret-secret"));
        assert!(dbg.contains("<redacted>"));
    }
}
