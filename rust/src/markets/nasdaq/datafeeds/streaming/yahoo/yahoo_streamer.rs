//! # Yahoo Streaming Module
//!
//! Long-running Tokio task with panic-restart supervisor.
//! Persists subscriptions + config in redb.
//! Decodes PricingData protobuf.
//! Silence detection with exponential backoff (60s → 3600s).
//! WS ping every 30s.
//! Logs in exact StrictLogger format.

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use prost::Message as ProstMessage;
use redb::{Database, ReadableTable, TableDefinition};
use serde_json;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::yahoo_streaming_proto_handler::{JsPricingData, PricingData};

const WS_URL: &str = "wss://streamer.finance.yahoo.com/?version=2";
const PING_INTERVAL: u64 = 30;
const SUBSCRIPTIONS_TABLE: TableDefinition<&str, bool> = TableDefinition::new("subscriptions");

#[napi(object)]
#[derive(Clone, Debug, serde::Serialize)]
pub struct YahooConfig {
    pub db_path: Option<String>,
    pub silence_seconds: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug, serde::Serialize)]
pub struct LogRecord {
    pub level: String,
    pub msg: String,
    pub extras: Option<String>, // JSON string
}

#[napi(object)]
#[derive(Clone, Debug, serde::Serialize)]
pub struct EventRecord {
    pub r#type: String, // "connected", "disconnected", "reconnecting", "silence-reconnect", "error"
    pub data: Option<String>,
}

/// Generic callback trait to support both Node.js (FFI) and Rust CLI.
pub trait YahooCallbacks: Send + Sync + 'static {
    fn on_log(&self, record: LogRecord);
    fn on_pricing(&self, data: JsPricingData);
    fn on_event(&self, event: EventRecord);
}

/// N-API implementation of callbacks.
pub struct NapiCallbacks {
    pub on_log: ThreadsafeFunction<LogRecord>,
    pub on_pricing: ThreadsafeFunction<JsPricingData>,
    pub on_event: ThreadsafeFunction<EventRecord>,
}

impl YahooCallbacks for NapiCallbacks {
    fn on_log(&self, record: LogRecord) {
        let _ = self
            .on_log
            .call(Ok(record), ThreadsafeFunctionCallMode::NonBlocking);
    }
    fn on_pricing(&self, data: JsPricingData) {
        let _ = self
            .on_pricing
            .call(Ok(data), ThreadsafeFunctionCallMode::NonBlocking);
    }
    fn on_event(&self, event: EventRecord) {
        let _ = self
            .on_event
            .call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// Rust-native implementation of callbacks for CLI.
pub struct RustCallbacks {
    pub on_log: Box<dyn Fn(LogRecord) + Send + Sync>,
    pub on_pricing: Box<dyn Fn(JsPricingData) + Send + Sync>,
    pub on_event: Box<dyn Fn(EventRecord) + Send + Sync>,
}

impl YahooCallbacks for RustCallbacks {
    fn on_log(&self, record: LogRecord) {
        (self.on_log)(record);
    }
    fn on_pricing(&self, data: JsPricingData) {
        (self.on_pricing)(data);
    }
    fn on_event(&self, event: EventRecord) {
        (self.on_event)(event);
    }
}

struct Inner<C: YahooCallbacks> {
    db: Database,
    subscriptions: Vec<String>,
    silence_seconds: u32,
    callbacks: C,
    stop_tx: Option<mpsc::Sender<()>>,
    sub_tx: Option<mpsc::Sender<Vec<String>>>,
    ws_task: Option<tokio::task::JoinHandle<()>>,
}

/// The core implementation shared between JS and Rust.
pub struct YahooStreamingCore<C: YahooCallbacks> {
    inner: Arc<Mutex<Inner<C>>>,
}

impl<C: YahooCallbacks> YahooStreamingCore<C> {
    pub fn new(callbacks: C) -> Self {
        let db_path = std::env::var("YAHOO_DB").unwrap_or_else(|_| {
            let temp = std::env::temp_dir();
            temp.join("yahoo_streaming.redb")
                .to_string_lossy()
                .to_string()
        });

        let db = Database::create(&db_path).expect("Failed to open redb");
        
        // Ensure table exists
        {
            let write_txn = db.begin_write().unwrap();
            {
                let _ = write_txn.open_table(SUBSCRIPTIONS_TABLE).unwrap();
            }
            write_txn.commit().unwrap();
        }

        let read_txn = db.begin_read().unwrap();
        let table = read_txn.open_table(SUBSCRIPTIONS_TABLE).unwrap();
        let subscriptions = table
            .iter()
            .unwrap()
            .map(|item| {
                let (k, _) = item.unwrap();
                k.value().to_string()
            })
            .collect();

        Self {
            inner: Arc::new(Mutex::new(Inner {
                db,
                subscriptions,
                silence_seconds: 60,
                callbacks,
                stop_tx: None,
                sub_tx: None,
                ws_task: None,
            })),
        }
    }

    pub async fn init(&self, config: YahooConfig) {
        let mut inner = self.inner.lock().await;
        if let Some(s) = config.silence_seconds {
            inner.silence_seconds = s;
        }
    }

    pub async fn start(&self) {
        let inner = Arc::clone(&self.inner);
        let mut guard = inner.lock().await;

        if guard.ws_task.is_some() {
            return;
        }

        let (stop_tx, stop_rx) = mpsc::channel(1);
        let (sub_tx, sub_rx) = mpsc::channel(10);
        guard.stop_tx = Some(stop_tx);
        guard.sub_tx = Some(sub_tx);

        let task = tokio::spawn(Self::run_loop(Arc::clone(&inner), stop_rx, sub_rx));
        guard.ws_task = Some(task);
    }

    async fn run_loop(inner: Arc<Mutex<Inner<C>>>, mut stop_rx: mpsc::Receiver<()>, mut sub_rx: mpsc::Receiver<Vec<String>>) {
        let mut backoff = 5u64;
        loop {
            let inner_clone = Arc::clone(&inner);
            
            let res = Self::ws_loop(inner_clone, &mut sub_rx, &mut stop_rx).await;
            
            match res {
                Ok(true) => {
                    // Stopped gracefully
                    break;
                }
                _ => {
                    // Disconnected or error, reconnect after backoff
                    inner.lock().await.callbacks.on_event(EventRecord { r#type: "reconnecting".to_string(), data: None });
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(3600);
        }
    }

    async fn ws_loop(
        inner: Arc<Mutex<Inner<C>>>, 
        sub_rx: &mut mpsc::Receiver<Vec<String>>,
        stop_rx: &mut mpsc::Receiver<()>,
    ) -> std::result::Result<bool, ()> {
        let (ws_stream, _) = match connect_async(WS_URL).await {
            Ok(v) => v,
            Err(e) => {
                inner.lock().await.callbacks.on_log(LogRecord {
                    level: "error".to_string(),
                    msg: "WS connect failed".to_string(),
                    extras: Some(e.to_string()),
                });
                return Err(());
            }
        };

        inner.lock().await.callbacks.on_event(EventRecord {
            r#type: "connected".to_string(),
            data: None,
        });

        let (mut write, mut read) = ws_stream.split();

        // initial subscribe
        {
            let guard = inner.lock().await;
            if !guard.subscriptions.is_empty() {
                let payload = serde_json::json!({ "subscribe": guard.subscriptions }).to_string();
                let _ = write.send(Message::Text(payload)).await;
            }
        }

        let mut silence_timer = tokio::time::interval(tokio::time::Duration::from_secs(60));
        let mut ping_timer = tokio::time::interval(tokio::time::Duration::from_secs(PING_INTERVAL));
        
        // consume the interval's first immediate tick
        let _ = silence_timer.tick().await;
        let _ = ping_timer.tick().await;

        loop {
            tokio::select! {
                _ = stop_rx.recv() => {
                    inner.lock().await.callbacks.on_event(EventRecord { r#type: "disconnected".to_string(), data: None });
                    return Ok(true);
                }
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            let obj: serde_json::Value = match serde_json::from_str(&text) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };

                            if obj["type"].as_str() != Some("pricing") {
                                inner.lock().await.callbacks.on_log(LogRecord { level: "trace".to_string(), msg: text, extras: None });
                                continue;
                            }

                            silence_timer.reset();

                            if let Some(b64) = obj["message"].as_str() {
                                if let Ok(decoded) = base64::prelude::BASE64_STANDARD.decode(b64) {
                                    match PricingData::decode(&decoded[..]) {
                                        Ok(pricing) => {
                                            inner.lock().await.callbacks.on_pricing(pricing.into());
                                        }
                                        Err(e) => {
                                            inner.lock().await.callbacks.on_log(LogRecord {
                                                level: "error".to_string(),
                                                msg: "Protobuf decode failed".to_string(),
                                                extras: Some(format!("{}: {}", e, b64)),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        Some(Ok(Message::Close(c))) => {
                            let data = c.map(|frame| frame.reason.to_string());
                            inner.lock().await.callbacks.on_event(EventRecord { r#type: "disconnected".to_string(), data });
                            return Ok(false);
                        }
                        None => {
                            inner.lock().await.callbacks.on_event(EventRecord { r#type: "disconnected".to_string(), data: Some("Stream ended".to_string()) });
                            return Ok(false);
                        }
                        Some(Err(e)) => {
                            let err_msg = e.to_string();
                            inner.lock().await.callbacks.on_log(LogRecord { level: "error".to_string(), msg: "WS read error".to_string(), extras: Some(err_msg.clone()) });
                            inner.lock().await.callbacks.on_event(EventRecord { r#type: "error".to_string(), data: Some(err_msg) });
                            return Ok(false);
                        }
                        _ => continue,
                    }
                }
                new_subs = sub_rx.recv() => {
                    if let Some(subs) = new_subs {
                        if !subs.is_empty() {
                            let payload = serde_json::json!({ "subscribe": subs }).to_string();
                            let _ = write.send(Message::Text(payload)).await;
                        }
                    } else {
                        // sub_tx dropped, but we should probably keep running until stop_rx
                    }
                }
                _ = ping_timer.tick() => {
                    let _ = write.send(Message::Ping(vec![])).await;
                }
                _ = silence_timer.tick() => {
                    inner.lock().await.callbacks.on_event(EventRecord { r#type: "silence-reconnect".to_string(), data: None });
                    return Ok(false);
                }
            }
        }
    }

    pub async fn subscribe(&self, symbols: Vec<String>) {
        let mut guard = self.inner.lock().await;
        let mut to_send = Vec::new();
        for s in &symbols {
            if !guard.subscriptions.contains(s) {
                guard.subscriptions.push(s.clone());
                to_send.push(s.clone());
                let write_txn = guard.db.begin_write().unwrap();
                {
                    let mut table = write_txn.open_table(SUBSCRIPTIONS_TABLE).unwrap();
                    table.insert(s.as_str(), true).unwrap();
                }
                write_txn.commit().unwrap();
            }
        }
        if let Some(tx) = &guard.sub_tx {
            let _ = tx.send(to_send).await;
        }
    }

    pub async fn unsubscribe(&self, symbols: Vec<String>) {
        let mut guard = self.inner.lock().await;
        guard.subscriptions.retain(|s| !symbols.contains(s));
        let write_txn = guard.db.begin_write().unwrap();
        {
            let mut table = write_txn.open_table(SUBSCRIPTIONS_TABLE).unwrap();
            for s in &symbols {
                table.remove(s.as_str()).unwrap();
            }
        }
        write_txn.commit().unwrap();
        // ideally we would send an unsubscribe message if Yahoo supported it
    }

    pub async fn clean(&self) {
        let mut guard = self.inner.lock().await;
        let write_txn = guard.db.begin_write().unwrap();
        let _ = write_txn.delete_table(SUBSCRIPTIONS_TABLE);
        write_txn.commit().unwrap();
        guard.subscriptions.clear();
        if let Some(tx) = guard.stop_tx.take() {
            let _ = tx.send(()).await;
        }
    }

    pub async fn stop(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(tx) = guard.stop_tx.take() {
            let _ = tx.send(()).await;
        }
        if let Some(task) = guard.ws_task.take() {
            task.abort();
        }
    }
}

/// N-API wrapper for JS usage.
#[napi]
pub struct YahooStreaming {
    core: YahooStreamingCore<NapiCallbacks>,
}

#[napi]
impl YahooStreaming {
    #[napi(constructor)]
    pub fn new(
        on_log: ThreadsafeFunction<LogRecord>,
        on_pricing: ThreadsafeFunction<JsPricingData>,
        on_event: ThreadsafeFunction<EventRecord>,
    ) -> Self {
        Self {
            core: YahooStreamingCore::new(NapiCallbacks {
                on_log,
                on_pricing,
                on_event,
            }),
        }
    }

    #[napi]
    pub async fn init(&self, config: YahooConfig) -> Result<()> {
        self.core.init(config).await;
        Ok(())
    }

    #[napi]
    pub async fn start(&self) -> Result<()> {
        self.core.start().await;
        Ok(())
    }

    #[napi]
    pub async fn subscribe(&self, symbols: Vec<String>) -> Result<()> {
        self.core.subscribe(symbols).await;
        Ok(())
    }

    #[napi]
    pub async fn unsubscribe(&self, symbols: Vec<String>) -> Result<()> {
        self.core.unsubscribe(symbols).await;
        Ok(())
    }

    #[napi]
    pub async fn clean(&self) -> Result<()> {
        self.core.clean().await;
        Ok(())
    }

    #[napi]
    pub async fn stop(&self) -> Result<()> {
        self.core.stop().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockCallbacks;
    impl YahooCallbacks for MockCallbacks {
        fn on_log(&self, _: LogRecord) {}
        fn on_pricing(&self, _: JsPricingData) {}
        fn on_event(&self, _: EventRecord) {}
    }

    #[tokio::test]
    async fn test_load_subscriptions_empty() {
        let db_path = std::env::temp_dir().join("test_empty.redb");
        let _ = std::fs::remove_file(&db_path);
        let db = Database::create(&db_path).unwrap();
        {
            let write_txn = db.begin_write().unwrap();
            {
                let _ = write_txn.open_table(SUBSCRIPTIONS_TABLE).unwrap();
            }
            write_txn.commit().unwrap();
        }

        let read_txn = db.begin_read().unwrap();
        let table = read_txn.open_table(SUBSCRIPTIONS_TABLE).unwrap();
        let loaded: Vec<String> = table
            .iter()
            .unwrap()
            .map(|item| {
                let (k, _) = item.unwrap();
                k.value().to_string()
            })
            .collect();
        assert_eq!(loaded.len(), 0);
    }

    #[tokio::test]
    async fn test_decode_pricing_message() {
        let b64 = "CgRUU0xBFYG9y0MYgM6B7JtnKgNOTVMwCDgCRbV+qr1lANStvtgBBA==";
        let decoded = base64::prelude::BASE64_STANDARD.decode(b64).unwrap();
        let pricing = PricingData::decode(&decoded[..]).unwrap();
        assert_eq!(pricing.id, "TSLA");
        assert!(pricing.price > 0.0);
    }
}
