// =============================================
// FILE: rust/src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streamer.rs
// PURPOSE: Long-running Yahoo Finance price stream handler.
// DESCRIPTION: This module provides a robust, supervised price streamer using 
// Yahoo Finance's WebSocket API. It decodes protobuf-encoded pricing messages, 
// persists subscriptions in a local `redb` database, and handles network 
// instability with silence detection and exponential backoff reconnection.
// =============================================

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use prost::Message as ProstMessage;
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use serde_json;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::yahoo_streaming_proto_handler::{JsPricingData, PricingData};

/// The production WebSocket URL for the Yahoo Finance streamer.
const WS_URL: &str = "wss://streamer.finance.yahoo.com/?version=2";
/// Interval in seconds for sending WebSocket ping frames to keep the connection alive.
const PING_INTERVAL: u64 = 30;
/// The `redb` table definition used to persist symbol subscriptions.
const SUBSCRIPTIONS_TABLE: TableDefinition<&str, bool> = TableDefinition::new("subscriptions");

/// Configuration parameters for the Yahoo price streamer.
#[napi(object)]
#[derive(Clone, Debug, serde::Serialize)]
pub struct YahooConfig {
    /// Optional path to the `redb` database file. Defaults to a temporary directory.
    pub db_path: Option<String>,
    /// Threshold in seconds for silence detection before triggering a reconnect.
    pub silence_seconds: Option<u32>,
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

/// A generic trait for handling streamer callbacks, supporting both FFI and native Rust.
pub trait YahooCallbacks: Send + Sync + 'static {
    /// Called when the streamer emits a log message.
    fn on_log(&self, record: LogRecord);
    /// Called when a new price update is successfully decoded.
    fn on_pricing(&self, data: JsPricingData);
    /// Called when a lifecycle event occurs (connection state changes).
    fn on_event(&self, event: EventRecord);
}

/// An N-API compatible implementation of `YahooCallbacks` for Node.js integration.
pub struct NapiCallbacks {
    /// JavaScript callback for logging.
    pub on_log: ThreadsafeFunction<LogRecord>,
    /// JavaScript callback for price updates.
    pub on_pricing: ThreadsafeFunction<JsPricingData>,
    /// JavaScript callback for lifecycle events.
    pub on_event: ThreadsafeFunction<EventRecord>,
}

impl YahooCallbacks for NapiCallbacks {
    fn on_log(&self, record: LogRecord) {
        // Trigger the JS log callback in a non-blocking way
        let _ = self
            .on_log
            .call(Ok(record), ThreadsafeFunctionCallMode::NonBlocking);
    }
    fn on_pricing(&self, data: JsPricingData) {
        // Trigger the JS pricing callback
        let _ = self
            .on_pricing
            .call(Ok(data), ThreadsafeFunctionCallMode::NonBlocking);
    }
    fn on_event(&self, event: EventRecord) {
        // Trigger the JS event callback
        let _ = self
            .on_event
            .call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// A native Rust implementation of `YahooCallbacks` for use in CLI or standalone apps.
pub struct RustCallbacks {
    /// closure for handling logs.
    pub on_log: Box<dyn Fn(LogRecord) + Send + Sync>,
    /// closure for handling price updates.
    pub on_pricing: Box<dyn Fn(JsPricingData) + Send + Sync>,
    /// closure for handling events.
    pub on_event: Box<dyn Fn(EventRecord) + Send + Sync>,
}

impl YahooCallbacks for RustCallbacks {
    fn on_log(&self, record: LogRecord) {
        // Execute the log closure
        (self.on_log)(record);
    }
    fn on_pricing(&self, data: JsPricingData) {
        // Execute the pricing closure
        (self.on_pricing)(data);
    }
    fn on_event(&self, event: EventRecord) {
        // Execute the event closure
        (self.on_event)(event);
    }
}

/// Internal state holder for the streamer logic.
struct Inner<C: YahooCallbacks> {
    /// The persistent local database instance.
    db: Database,
    /// List of current symbol subscriptions.
    subscriptions: Vec<String>,
    /// Configured silence threshold for reconnections.
    silence_seconds: u32,
    /// The callback implementation (N-API or Rust).
    callbacks: C,
    /// Channel for sending a stop signal to the background task.
    stop_tx: Option<mpsc::Sender<()>>,
    /// Channel for sending new symbol subscriptions to the active stream.
    sub_tx: Option<mpsc::Sender<Vec<String>>>,
    /// Join handle for the active WebSocket task.
    ws_task: Option<tokio::task::JoinHandle<()>>,
}

/// The core price streamer implementation, generic over its callback mechanism.
pub struct YahooStreamingCore<C: YahooCallbacks> {
    /// Shared, thread-safe access to the internal state.
    inner: Arc<Mutex<Inner<C>>>,
}

impl<C: YahooCallbacks> YahooStreamingCore<C> {
    /// Creates a new `YahooStreamingCore` and initializes the local database.
    pub fn new(callbacks: C) -> Self {
        // Determine the database path from environment or use a temporary file
        let db_path = std::env::var("YAHOO_DB").unwrap_or_else(|_| {
            let temp = std::env::temp_dir();
            temp.join("yahoo_streaming.redb")
                .to_string_lossy()
                .to_string()
        });

        // Open or create the redb database
        let db = Database::create(&db_path).expect("Failed to open redb");

        // Ensure the subscriptions table exists in the database
        {
            let write_txn = db.begin_write().unwrap();
            {
                let _ = write_txn.open_table(SUBSCRIPTIONS_TABLE).unwrap();
            }
            write_txn.commit().unwrap();
        }

        // Load existing subscriptions from the database into memory
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
                silence_seconds: 60, // Default to 60s silence check
                callbacks,
                stop_tx: None,
                sub_tx: None,
                ws_task: None,
            })),
        }
    }

    /// Initializes the streamer with the provided configuration.
    pub async fn init(&self, config: YahooConfig) {
        let mut inner = self.inner.lock().await;
        // Override the silence threshold if provided
        if let Some(s) = config.silence_seconds {
            inner.silence_seconds = s;
        }
    }

    /// Spawns the supervisor loop and starts the price stream.
    pub async fn start(&self) {
        let inner = Arc::clone(&self.inner);
        let mut guard = inner.lock().await;

        // Prevent multiple concurrent tasks from running
        if guard.ws_task.is_some() {
            return;
        }

        // Initialize communication channels
        let (stop_tx, stop_rx) = mpsc::channel(1);
        let (sub_tx, sub_rx) = mpsc::channel(10);
        guard.stop_tx = Some(stop_tx);
        guard.sub_tx = Some(sub_tx);

        // Spawn the main supervisor task
        let task = tokio::spawn(Self::run_loop(Arc::clone(&inner), stop_rx, sub_rx));
        guard.ws_task = Some(task);
    }

    /// Background loop that handles reconnections with exponential backoff.
    async fn run_loop(
        inner: Arc<Mutex<Inner<C>>>,
        mut stop_rx: mpsc::Receiver<()>,
        mut sub_rx: mpsc::Receiver<Vec<String>>,
    ) {
        // Initial backoff duration in seconds
        let mut backoff = 5u64;
        loop {
            let inner_clone = Arc::clone(&inner);

            // Execute the actual WebSocket logic
            let res = Self::ws_loop(inner_clone, &mut sub_rx, &mut stop_rx).await;

            match res {
                Ok(true) => {
                    // Stream stopped gracefully via stop() call
                    break;
                }
                _ => {
                    // Connection lost or error occurred, trigger a reconnect event
                    inner.lock().await.callbacks.on_event(EventRecord {
                        r#type: "reconnecting".to_string(),
                        data: None,
                    });
                }
            }

            // Sleep for the backoff duration before the next reconnect attempt
            tokio::time::sleep(tokio::time::Duration::from_secs(backoff)).await;
            // Double the backoff duration up to a maximum of 1 hour
            backoff = (backoff * 2).min(3600);
        }
    }

    /// Handles the active WebSocket connection and message dispatching.
    async fn ws_loop(
        inner: Arc<Mutex<Inner<C>>>,
        sub_rx: &mut mpsc::Receiver<Vec<String>>,
        stop_rx: &mut mpsc::Receiver<()>,
    ) -> std::result::Result<bool, ()> {
        // Attempt to connect to the Yahoo Finance WebSocket server
        let (ws_stream, _) = match connect_async(WS_URL).await {
            Ok(v) => v,
            Err(e) => {
                // Log connection failure and return to the supervisor for backoff
                inner.lock().await.callbacks.on_log(LogRecord {
                    level: "error".to_string(),
                    msg: "WS connect failed".to_string(),
                    extras: Some(e.to_string()),
                });
                return Err(());
            }
        };

        // Notify that the connection has been established
        inner.lock().await.callbacks.on_event(EventRecord {
            r#type: "connected".to_string(),
            data: None,
        });

        // Split the stream into a writer and a reader
        let (mut write, mut read) = ws_stream.split();

        // Send the initial subscription payload for all currently tracked symbols
        {
            let guard = inner.lock().await;
            if !guard.subscriptions.is_empty() {
                let payload = serde_json::json!({ "subscribe": guard.subscriptions }).to_string();
                let _ = write.send(Message::Text(payload.into())).await;
            }
        }

        // Initialize timers for silence detection and WebSocket pings
        let mut silence_timer = tokio::time::interval(tokio::time::Duration::from_secs(60));
        let mut ping_timer = tokio::time::interval(tokio::time::Duration::from_secs(PING_INTERVAL));

        // Consume the immediate first ticks of the intervals
        let _ = silence_timer.tick().await;
        let _ = ping_timer.tick().await;

        loop {
            // Select over various input sources
            tokio::select! {
                // Handle graceful stop signal
                _ = stop_rx.recv() => {
                    inner.lock().await.callbacks.on_event(EventRecord { r#type: "disconnected".to_string(), data: None });
                    return Ok(true);
                }
                // Handle incoming WebSocket messages
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            // Parse the envelope JSON from Yahoo
                            let obj: serde_json::Value = match serde_json::from_str(&text) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };

                            // Only process messages typed as "pricing"
                            if obj["type"].as_str() != Some("pricing") {
                                // Log unexpected message types at trace level
                                inner.lock().await.callbacks.on_log(LogRecord {
                                    level: "trace".to_string(),
                                    msg: text.to_string(),
                                    extras: None,
                                });
                                continue;
                            }

                            // Pricing data received, reset the silence timer
                            silence_timer.reset();

                            // Decode the base64 pricing message and then the protobuf payload
                            if let Some(b64) = obj["message"].as_str() {
                                if let Ok(decoded) = base64::prelude::BASE64_STANDARD.decode(b64) {
                                    match PricingData::decode(&decoded[..]) {
                                        Ok(pricing) => {
                                            // Trigger the pricing callback with the decoded struct
                                            inner.lock().await.callbacks.on_pricing(pricing.into());
                                        }
                                        Err(e) => {
                                            // Log decoding failures
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
                        // Handle WebSocket close frames
                        Some(Ok(Message::Close(c))) => {
                            let data = c.map(|frame| frame.reason.to_string());
                            inner.lock().await.callbacks.on_event(EventRecord { r#type: "disconnected".to_string(), data });
                            return Ok(false);
                        }
                        // Handle unexpected end of stream
                        None => {
                            inner.lock().await.callbacks.on_event(EventRecord { r#type: "disconnected".to_string(), data: Some("Stream ended".to_string()) });
                            return Ok(false);
                        }
                        // Handle WebSocket errors
                        Some(Err(e)) => {
                            let err_msg = e.to_string();
                            inner.lock().await.callbacks.on_log(LogRecord { level: "error".to_string(), msg: "WS read error".to_string(), extras: Some(err_msg.clone()) });
                            inner.lock().await.callbacks.on_event(EventRecord { r#type: "error".to_string(), data: Some(err_msg) });
                            return Ok(false);
                        }
                        _ => continue,
                    }
                }
                // Handle new symbol subscriptions added while the stream is active
                new_subs = sub_rx.recv() => {
                    if let Some(subs) = new_subs {
                        if !subs.is_empty() {
                            // Construct and send the subscription message to Yahoo
                            let payload = serde_json::json!({ "subscribe": subs }).to_string();
                            let _ = write.send(Message::Text(payload.into())).await;
                        }
                    }
                }
                // Send periodic ping frames to the server
                _ = ping_timer.tick() => {
                    let _ = write.send(Message::Ping(vec![].into())).await;
                }
                // Reconnect if no data has been received for the silence threshold
                _ = silence_timer.tick() => {
                    inner.lock().await.callbacks.on_event(EventRecord { r#type: "silence-reconnect".to_string(), data: None });
                    return Ok(false);
                }
            }
        }
    }

    /// Subscribes to a list of symbols and persists them in the database.
    pub async fn subscribe(&self, symbols: Vec<String>) {
        let mut guard = self.inner.lock().await;
        let mut to_send = Vec::new();
        for s in &symbols {
            // Only add and persist if not already subscribed
            if !guard.subscriptions.contains(s) {
                guard.subscriptions.push(s.clone());
                to_send.push(s.clone());
                
                // Persist the new subscription in redb
                let write_txn = guard.db.begin_write().unwrap();
                {
                    let mut table = write_txn.open_table(SUBSCRIPTIONS_TABLE).unwrap();
                    table.insert(s.as_str(), true).unwrap();
                }
                write_txn.commit().unwrap();
            }
        }
        // If the background task is running, send the new symbols via the channel
        if let Some(tx) = &guard.sub_tx {
            let _ = tx.send(to_send).await;
        }
    }

    /// Unsubscribes from a list of symbols and removes them from the database.
    pub async fn unsubscribe(&self, symbols: Vec<String>) {
        let mut guard = self.inner.lock().await;
        // Remove symbols from memory
        guard.subscriptions.retain(|s| !symbols.contains(s));
        
        // Remove symbols from the persistent database
        let write_txn = guard.db.begin_write().unwrap();
        {
            let mut table = write_txn.open_table(SUBSCRIPTIONS_TABLE).unwrap();
            for s in &symbols {
                table.remove(s.as_str()).unwrap();
            }
        }
        write_txn.commit().unwrap();
        // NOTE: Yahoo does not currently support an explicit 'unsubscribe' message via WebSocket.
    }

    /// Clears all subscriptions and stops the streamer.
    pub async fn clean(&self) {
        let mut guard = self.inner.lock().await;
        // Delete the entire subscriptions table
        let write_txn = guard.db.begin_write().unwrap();
        let _ = write_txn.delete_table(SUBSCRIPTIONS_TABLE);
        write_txn.commit().unwrap();
        
        // Reset in-memory state
        guard.subscriptions.clear();
        // Stop the active task
        if let Some(tx) = guard.stop_tx.take() {
            let _ = tx.send(()).await;
        }
    }

    /// Stops the background task without clearing persistent subscriptions.
    pub async fn stop(&self) {
        let mut guard = self.inner.lock().await;
        // Signal the task to stop
        if let Some(tx) = guard.stop_tx.take() {
            let _ = tx.send(()).await;
        }
        // Force abort the task if it doesn't respond to the signal
        if let Some(task) = guard.ws_task.take() {
            task.abort();
        }
    }
}

/// N-API wrapper for the price streamer, enabling its use in JavaScript environments.
#[napi]
pub struct YahooStreaming {
    /// The core implementation using N-API callbacks.
    core: YahooStreamingCore<NapiCallbacks>,
}

#[napi]
impl YahooStreaming {
    /// Constructs a new `YahooStreaming` instance with the provided JavaScript callback functions.
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

    /// Initializes the streamer with configuration parameters.
    #[napi]
    pub async fn init(&self, config: YahooConfig) -> Result<()> {
        self.core.init(config).await;
        Ok(())
    }

    /// Starts the long-running streaming task.
    #[napi]
    pub async fn start(&self) -> Result<()> {
        self.core.start().await;
        Ok(())
    }

    /// Adds a list of symbols to the active stream.
    #[napi]
    pub async fn subscribe(&self, symbols: Vec<String>) -> Result<()> {
        self.core.subscribe(symbols).await;
        Ok(())
    }

    /// Removes a list of symbols from the active stream.
    #[napi]
    pub async fn unsubscribe(&self, symbols: Vec<String>) -> Result<()> {
        self.core.unsubscribe(symbols).await;
        Ok(())
    }

    /// Clears all subscriptions and stops the stream.
    #[napi]
    pub async fn clean(&self) -> Result<()> {
        self.core.clean().await;
        Ok(())
    }

    /// Gracefully stops the streaming task.
    #[napi]
    pub async fn stop(&self) -> Result<()> {
        self.core.stop().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
    struct MockCallbacks;
    impl YahooCallbacks for MockCallbacks {
        fn on_log(&self, _: LogRecord) {}
        fn on_pricing(&self, _: JsPricingData) {}
        fn on_event(&self, _: EventRecord) {}
    }
    */

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
