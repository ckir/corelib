//! Unified, source-tagged market event schema (internal; mapped to flat FFI payloads by facades).
use chrono::{DateTime, Utc};

/// The kind of provider a driver handles.
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Alpaca,
    Finnhub,
    Yahoo,
}

impl std::fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            ProviderKind::Alpaca => "alpaca",
            ProviderKind::Finnhub => "finnhub",
            ProviderKind::Yahoo => "yahoo",
        };
        f.write_str(s)
    }
}

/// Finnhub-specific trade metadata.
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone)]
pub struct FinnhubTradeExtras {
    pub volume: f64,
    pub conditions: Vec<String>,
}

/// Provider-specific trade metadata (extended per provider in later phases).
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone)]
pub enum TradeExtras {
    Finnhub(FinnhubTradeExtras),
}

/// A normalized trade.
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone)]
pub struct Trade {
    pub ticker: String,
    pub timestamp: DateTime<Utc>,
    pub price: f64,
    pub extras: TradeExtras,
    pub raw: Option<String>,
}

/// Connectivity/health state of a driver.
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone)]
pub enum ProviderStatus {
    Connected {
        provider: ProviderKind,
    },
    Disconnected {
        provider: ProviderKind,
        reason: String,
    },
    Reconnecting {
        provider: ProviderKind,
        attempt: u32,
        delay_ms: u64,
    },
    Error {
        provider: ProviderKind,
        message: String,
    },
}

/// A normalized, source-tagged event emitted by a driver.
#[allow(dead_code)] // wired up in later tasks
#[derive(Debug, Clone)]
pub enum MarketEvent {
    Trade {
        source: String,
        data: Trade,
    },
    Status {
        source: String,
        status: ProviderStatus,
    },
}
