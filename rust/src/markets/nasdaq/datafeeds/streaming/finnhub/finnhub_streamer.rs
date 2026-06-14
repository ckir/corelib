//! FinnhubStreaming N-API facade, flat payload, and MarketEvent→flat mapper.
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{MarketEvent, Trade, TradeExtras};
pub use crate::markets::nasdaq::datafeeds::streaming::core::types::FinnhubPricingData;
use napi_derive::napi;
use serde::{Deserialize, Serialize};

/// Map a MarketEvent::Trade to the flat FinnhubPricingData. Returns None for non-pricing events.
pub fn market_event_to_finnhub_pricing(ev: &MarketEvent) -> Option<FinnhubPricingData> {
    match ev {
        MarketEvent::Trade {
            data:
                Trade {
                    ticker,
                    timestamp,
                    price,
                    extras,
                    ..
                },
            ..
        } => {
            let (volume, conditions) = match extras {
                TradeExtras::Finnhub(x) => (x.volume, x.conditions.clone()),
                _ => return None,
            };
            Some(FinnhubPricingData {
                symbol: ticker.clone(),
                message_type: "trade".to_string(),
                price: *price,
                volume,
                timestamp: timestamp.timestamp_millis() as f64,
                conditions: if conditions.is_empty() {
                    None
                } else {
                    Some(conditions)
                },
            })
        }
        MarketEvent::Quote { .. } | MarketEvent::Status { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markets::nasdaq::datafeeds::streaming::core::schema::{
        FinnhubTradeExtras, ProviderKind, ProviderStatus,
    };
    use chrono::TimeZone;

    #[test]
    fn maps_trade_to_flat_payload() {
        let ev = MarketEvent::Trade {
            source: "finnhub_main".into(),
            data: Trade {
                ticker: "AAPL".into(),
                timestamp: chrono::Utc
                    .timestamp_millis_opt(1_700_000_000_000)
                    .single()
                    .unwrap(),
                price: 191.5,
                extras: TradeExtras::Finnhub(FinnhubTradeExtras {
                    volume: 100.0,
                    conditions: vec!["@".into()],
                }),
                raw: None,
            },
        };
        let p = market_event_to_finnhub_pricing(&ev).unwrap();
        assert_eq!(
            p,
            FinnhubPricingData {
                symbol: "AAPL".into(),
                message_type: "trade".into(),
                price: 191.5,
                volume: 100.0,
                timestamp: 1_700_000_000_000.0,
                conditions: Some(vec!["@".into()]),
            }
        );
    }
    #[test]
    fn status_events_are_not_pricing() {
        let ev = MarketEvent::Status {
            source: "finnhub_main".into(),
            status: ProviderStatus::Connected {
                provider: ProviderKind::Finnhub,
            },
        };
        assert!(market_event_to_finnhub_pricing(&ev).is_none());
    }

    #[test]
    fn finnhub_trade_maps_to_unified_market_event_trade() {
        let ev = MarketEvent::Trade {
            source: "finnhub_main".into(),
            data: Trade {
                ticker: "AAPL".into(),
                timestamp: chrono::Utc
                    .timestamp_millis_opt(1_700_000_000_000)
                    .single()
                    .unwrap(),
                price: 191.5,
                extras: TradeExtras::Finnhub(FinnhubTradeExtras {
                    volume: 100.0,
                    conditions: vec!["@".into()],
                }),
                raw: None,
            },
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "trade");
        assert_eq!(v["finnhub"]["volume"], 100.0);
    }
}

// ─── Task 9: FinnhubStreaming N-API facade ────────────────────────────────────

use crate::markets::nasdaq::datafeeds::streaming::core::host::{
    unique_db_path, WebsocketStreamerHost,
};
use crate::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use crate::markets::nasdaq::datafeeds::streaming::core::schema::{ProviderKind, ProviderStatus};
use crate::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use crate::markets::nasdaq::datafeeds::streaming::finnhub::finnhub_driver::FinnhubDriver;
use crate::{EventRecord, LogRecord};
use napi::bindgen_prelude::Unknown;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Bounded TSFN (Epic 5 ffi-tsfn-queue-unbounded): caps the off-heap queue at 4096; NonBlocking
/// delivery drops on overflow. Used for the high-rate market-data callbacks only.
type BoundedTsfn<T> = ThreadsafeFunction<T, Unknown<'static>, T, Status, true, false, 4096>;

/// Configuration for the Finnhub streaming facade. Token masked in Debug output.
#[napi(object)]
#[derive(Clone, Serialize, Deserialize)]
pub struct FinnhubConfig {
    pub token: Option<String>,
    pub name: Option<String>,
    pub base_url: Option<String>,
}

impl std::fmt::Debug for FinnhubConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FinnhubConfig")
            .field("name", &self.name)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("base_url", &self.base_url)
            .finish()
    }
}

/// Interior mutable state for `FinnhubStreaming`.
struct FinnhubInner {
    host: WebsocketStreamerHost,
    token: String,
    name: String,
    base_url: Option<String>,
    started: bool,
}

/// N-API facade for Finnhub real-time trade streaming.
/// Mirrors `AlpacaStreaming` exactly: 3-callback constructor, config via `async init`,
/// `&self` methods with interior mutability (`Arc<Mutex<FinnhubInner>>`).
///
/// `ThreadsafeFunction` does not implement `Clone`; we wrap each in `Arc` so the pump
/// closure can hold a cheap reference counted copy (same underlying napi handle).
#[napi]
pub struct FinnhubStreaming {
    inner: Arc<Mutex<FinnhubInner>>,
    on_log: Arc<ThreadsafeFunction<LogRecord>>,
    on_pricing: Arc<BoundedTsfn<FinnhubPricingData>>,
    on_event: Arc<ThreadsafeFunction<EventRecord>>,
    /// Optional unified-event sink: receives the finstream-superset `MarketEvent` as a JSON string.
    /// Absent when JS constructs with only 3 callbacks (back-compat).
    on_market_event: Option<Arc<BoundedTsfn<String>>>,
}

#[napi]
impl FinnhubStreaming {
    /// Constructs a new `FinnhubStreaming` with the JS callback functions.
    /// Order matches `AlpacaStreaming`: (on_log, on_pricing, on_event, [on_market_event]).
    /// `on_market_event` is optional — pass it to also receive the unified `"market"` stream.
    #[napi(constructor)]
    pub fn new(
        on_log: ThreadsafeFunction<LogRecord>,
        on_pricing: ThreadsafeFunction<FinnhubPricingData, Unknown<'static>, FinnhubPricingData, Status, true, false, 4096>,
        on_event: ThreadsafeFunction<EventRecord>,
        on_market_event: Option<ThreadsafeFunction<String, Unknown<'static>, String, Status, true, false, 4096>>,
    ) -> napi::Result<Self> {
        let host = WebsocketStreamerHost::new(
            unique_db_path("finnhub_streaming", "FINNHUB_DB"),
            "finnhub_subscriptions",
            "finnhub".to_string(),
            ProviderKind::Finnhub,
        )
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let inner = FinnhubInner {
            host,
            token: String::new(),
            name: "finnhub".to_string(),
            base_url: None,
            started: false,
        };
        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
            on_log: Arc::new(on_log),
            on_pricing: Arc::new(on_pricing),
            on_event: Arc::new(on_event),
            on_market_event: on_market_event.map(Arc::new),
        })
    }

    /// Set token/name (token falls back to `FINNHUB_API_KEY` env var).
    #[napi]
    pub async fn init(&self, config: FinnhubConfig) -> napi::Result<()> {
        let mut g = self.inner.lock().await;
        g.token = config
            .token
            .or_else(|| std::env::var("FINNHUB_API_KEY").ok())
            .unwrap_or_default();
        if let Some(n) = config.name {
            g.name = n;
        }
        g.base_url = config.base_url;
        Ok(())
    }

    /// Start streaming; resumes any persisted subscriptions (redb) as the initial symbol set.
    #[napi]
    pub async fn start(&self) -> napi::Result<()> {
        let mut g = self.inner.lock().await;
        if g.started {
            return Ok(());
        }
        let _ = self.on_log.call(
            Ok(LogRecord {
                level: "debug".into(),
                msg: "finnhub start".into(),
                extras: None,
            }),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        let driver = FinnhubDriver {
            token: g.token.clone(),
            name: g.name.clone(),
            base_url: g.base_url.clone(),
        };
        let symbols = g.host.get_persisted_subscriptions(); // resume-on-restart (redb)
                                                            // Arc-clone the TSFNs so the pump closure can hold them (TSFN is Send+Sync, not Clone).
        let on_pricing = Arc::clone(&self.on_pricing);
        let on_event = Arc::clone(&self.on_event);
        let on_market_event = self.on_market_event.clone();
        g.host.start(
            driver,
            symbols,
            ReconnectPolicy {
                jitter: true,
                ..Default::default()
            },
            move |ev: CoreEvent| match ev {
                // dual-mode: raw FinnhubPricingData via on_pricing + optional unified JSON via on_market_event.
                CoreEvent::Pricing {
                    raw: RawPricing::Finnhub(p),
                    uni,
                } => {
                    let _ = on_pricing.call(Ok(p), ThreadsafeFunctionCallMode::NonBlocking);
                    if let Some(cb) = on_market_event.as_ref() {
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
                // RawPricing::Alpaca never reaches the Finnhub pump.
                _ => {}
            },
        );
        g.started = true;
        Ok(())
    }

    /// Subscribe to additional symbols (persisted to redb + sent live to the driver).
    #[napi]
    pub async fn subscribe(&self, symbols: Vec<String>) -> napi::Result<()> {
        self.inner.lock().await.host.subscribe(symbols).await;
        Ok(())
    }

    /// Removes `symbols` from the persisted set (so they don't resume on restart). Live
    /// WS-unsubscribe through the driver is deferred to Phase 2.
    #[napi]
    pub async fn unsubscribe(&self, symbols: Vec<String>) -> napi::Result<()> {
        self.inner.lock().await.host.unsubscribe(symbols).await;
        Ok(())
    }

    /// Gracefully stops the streaming supervisor.
    #[napi]
    pub async fn stop(&self) -> napi::Result<()> {
        let mut g = self.inner.lock().await;
        if let Some(tx) = g.host.stop_tx.take() {
            let _ = tx.try_send(());
        }
        g.started = false;
        Ok(())
    }

    /// Dev-mode parity with `AlpacaStreaming.clean()` — Phase 1 no-op.
    #[napi]
    pub async fn clean(&self) -> napi::Result<()> {
        Ok(())
    }
}
