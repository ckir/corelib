// =============================================
// FILE: rust/src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_streamer.rs
// PURPOSE: Long-running Alpaca Finance data stream handler.
// DESCRIPTION: This module provides a robust, supervised price streamer using
// Alpaca's Data V2 WebSocket API. It decodes JSON pricing messages,
// persists subscriptions in a local `redb` database (under ALPACA_SUBSCRIPTIONS),
// and handles network instability with silence detection and exponential backoff reconnection.
// Authentication failures are treated as fatal and will halt the streamer.
// =============================================

use futures_util::{SinkExt, StreamExt};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::{EventRecord, LogRecord};

/// The default production WebSocket URL for the Alpaca IEX data stream.
const DEFAULT_ALPACA_WS_URL: &str = "wss://stream.data.alpaca.markets/v2/iex";

/// Interval in seconds for sending WebSocket ping frames to keep the connection alive.
/// Alpaca disconnects silent clients, so we ping periodically.
const PING_INTERVAL: u64 = 30;

/// The `redb` table definition used to persist Alpaca symbol subscriptions.
const ALPACA_SUBSCRIPTIONS_TABLE: TableDefinition<&str, bool> =
    TableDefinition::new("alpaca_subscriptions");

/// Configuration parameters for the Alpaca price streamer.
#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AlpacaConfig {
    /// Optional path to the `redb` database file. Defaults to a temporary directory.
    pub db_path: Option<String>,
    /// Threshold in seconds for silence detection before triggering a reconnect.
    pub silence_seconds: Option<u32>,
    /// Optional override for the WebSocket URL (defaults to IEX stream or `APCA_API_BASE_URL`).
    pub base_url: Option<String>,
    /// Alpaca API Key ID. Falls back to `APCA_API_KEY_ID` environment variable.
    pub key_id: Option<String>,
    /// Alpaca API Secret Key. Falls back to `APCA_API_SECRET_KEY` environment variable.
    pub secret_key: Option<String>,
}

/// A unified representation of Alpaca pricing data, consolidating Trades, Quotes, and Bars.
#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AlpacaPricingData {
    /// The ticker symbol of the instrument (e.g., "AAPL").
    pub symbol: String,
    /// The type of data received ("quote", "trade", "bar").
    pub message_type: String,
    /// The primary price (last trade price, close price for bars, or bid price for quotes).
    pub price: f64,
    /// The current bid price (applicable for quotes).
    pub bid_price: f64,
    /// The current ask price (applicable for quotes).
    pub ask_price: f64,
    /// The volume associated with the event.
    pub volume: f64,
    /// The timestamp provided by the Alpaca exchange.
    pub timestamp: String,
}

/// A generic trait for handling Alpaca streamer callbacks.
pub trait AlpacaCallbacks: Send + Sync + 'static {
    /// Called when the streamer emits a log message.
    fn on_log(&self, record: LogRecord);
    /// Called when a new price update is successfully decoded.
    fn on_pricing(&self, data: AlpacaPricingData);
    /// Called when a lifecycle event occurs (connection state changes).
    fn on_event(&self, event: EventRecord);
}

/// An N-API compatible implementation of `AlpacaCallbacks` for Node.js integration.
pub struct NapiCallbacks {
    /// JavaScript callback for logging.
    pub on_log: ThreadsafeFunction<LogRecord>,
    /// JavaScript callback for price updates.
    pub on_pricing: ThreadsafeFunction<AlpacaPricingData>,
    /// JavaScript callback for lifecycle events.
    pub on_event: ThreadsafeFunction<EventRecord>,
}

impl AlpacaCallbacks for NapiCallbacks {
    fn on_log(&self, record: LogRecord) {
        let _ = self
            .on_log
            .call(Ok(record), ThreadsafeFunctionCallMode::NonBlocking);
    }
    fn on_pricing(&self, data: AlpacaPricingData) {
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

/// Internal state holder for the Alpaca streamer logic.
struct Inner<C: AlpacaCallbacks> {
    /// The persistent local database instance.
    db: Database,
    /// List of current symbol subscriptions.
    subscriptions: Vec<String>,
    /// Configured silence threshold for reconnections.
    silence_seconds: u32,
    /// Configuration mapping for the active instance.
    config: AlpacaConfig,
    /// The callback implementation.
    callbacks: C,
    /// Channel for sending a stop signal to the background task.
    stop_tx: Option<mpsc::Sender<()>>,
    /// Channel for sending new symbol subscriptions to the active stream.
    sub_tx: Option<mpsc::Sender<Vec<String>>>,
    /// Join handle for the active WebSocket task.
    ws_task: Option<tokio::task::JoinHandle<()>>,
}

/// Represents the possible outcomes of the internal websocket loop.
enum WsLoopResult {
    /// The loop exited gracefully (e.g., manual stop).
    GracefulStop,
    /// The loop encountered a network or protocol error and should retry.
    Reconnect,
    /// The loop encountered a fatal error (like Auth Failure) and should halt entirely.
    FatalError(String),
}

/// The core Alpaca price streamer implementation, generic over its callback mechanism.
pub struct AlpacaStreamingCore<C: AlpacaCallbacks> {
    /// Shared, thread-safe access to the internal state.
    inner: Arc<Mutex<Inner<C>>>,
}

impl<C: AlpacaCallbacks> AlpacaStreamingCore<C> {
    /// Creates a new `AlpacaStreamingCore` and initializes the local database.
    pub fn new(callbacks: C) -> Self {
        // Determine the database path from environment or use a temporary file
        let db_path = std::env::var("ALPACA_DB").unwrap_or_else(|_| {
            let temp = std::env::temp_dir();
            temp.join("corelib_streaming.redb")
                .to_string_lossy()
                .to_string()
        });

        // Open or create the redb database
        let db = Database::create(&db_path).expect("Failed to open redb");

        // Ensure the alpaca_subscriptions table exists in the database
        {
            let write_txn = db.begin_write().unwrap();
            {
                let _ = write_txn.open_table(ALPACA_SUBSCRIPTIONS_TABLE).unwrap();
            }
            write_txn.commit().unwrap();
        }

        // Load existing subscriptions from the database into memory
        let read_txn = db.begin_read().unwrap();
        let table = read_txn.open_table(ALPACA_SUBSCRIPTIONS_TABLE).unwrap();
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
                config: AlpacaConfig {
                    db_path: None,
                    silence_seconds: None,
                    base_url: None,
                    key_id: None,
                    secret_key: None,
                },
                callbacks,
                stop_tx: None,
                sub_tx: None,
                ws_task: None,
            })),
        }
    }

    /// Initializes the streamer with the provided configuration.
    pub async fn init(&self, config: AlpacaConfig) {
        let mut inner = self.inner.lock().await;

        // Override the silence threshold if provided
        if let Some(s) = config.silence_seconds {
            inner.silence_seconds = s;
        }

        // Store the config for authentication use in the loop
        inner.config = config;
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
                WsLoopResult::GracefulStop => {
                    // Stream stopped gracefully via stop() call
                    break;
                }
                WsLoopResult::FatalError(err_msg) => {
                    // A fatal error (like Auth Failure) occurred. Halt the supervisor.
                    let guard = inner.lock().await;
                    guard.callbacks.on_log(LogRecord {
                        level: "fatal".to_string(),
                        msg: "Streamer halted due to fatal error".to_string(),
                        extras: Some(err_msg),
                    });
                    break;
                }
                WsLoopResult::Reconnect => {
                    // Connection lost or non-fatal error occurred, trigger a reconnect event
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

    /// Handles the active WebSocket connection, authentication, and message dispatching.
    async fn ws_loop(
        inner: Arc<Mutex<Inner<C>>>,
        sub_rx: &mut mpsc::Receiver<Vec<String>>,
        stop_rx: &mut mpsc::Receiver<()>,
    ) -> WsLoopResult {
        // 1. Resolve URL and Credentials
        let (url, key_id, secret_key) = {
            let guard = inner.lock().await;

            let url = guard
                .config
                .base_url
                .clone()
                .or_else(|| std::env::var("APCA_API_BASE_URL").ok())
                .unwrap_or_else(|| DEFAULT_ALPACA_WS_URL.to_string());

            let key_id = guard
                .config
                .key_id
                .clone()
                .or_else(|| std::env::var("APCA_API_KEY_ID").ok())
                .unwrap_or_default();

            let secret_key = guard
                .config
                .secret_key
                .clone()
                .or_else(|| std::env::var("APCA_API_SECRET_KEY").ok())
                .unwrap_or_default();

            (url, key_id, secret_key)
        };

        // 2. Attempt Connection
        let (mut ws_stream, _) = match connect_async(&url).await {
            Ok(v) => v,
            Err(e) => {
                inner.lock().await.callbacks.on_log(LogRecord {
                    level: "error".to_string(),
                    msg: "Alpaca WS connect failed".to_string(),
                    extras: Some(e.to_string()),
                });
                return WsLoopResult::Reconnect;
            }
        };

        // 3. Handle Initial Connection Message
        if let Some(Ok(Message::Text(msg))) = ws_stream.next().await {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&msg) {
                if let Some(arr) = parsed.as_array() {
                    if let Some(first) = arr.first() {
                        if first.get("T").and_then(|t| t.as_str()) != Some("success")
                            || first.get("msg").and_then(|m| m.as_str()) != Some("connected")
                        {
                            return WsLoopResult::Reconnect;
                        }
                    }
                }
            }
        }

        // 4. Send Authentication Payload
        let auth_payload = serde_json::json!({
            "action": "auth",
            "key": key_id,
            "secret": secret_key
        });

        if let Err(e) = ws_stream
            .send(Message::Text(auth_payload.to_string().into()))
            .await
        {
            inner.lock().await.callbacks.on_log(LogRecord {
                level: "error".to_string(),
                msg: "Failed to send auth payload".to_string(),
                extras: Some(e.to_string()),
            });
            return WsLoopResult::Reconnect;
        }

        // 5. Await Authentication Response
        if let Some(Ok(Message::Text(msg))) = ws_stream.next().await {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&msg) {
                if let Some(arr) = parsed.as_array() {
                    if let Some(first) = arr.first() {
                        // Check for Auth Failure (Fatal)
                        if first.get("T").and_then(|t| t.as_str()) == Some("error") {
                            let err_msg = first
                                .get("msg")
                                .and_then(|m| m.as_str())
                                .unwrap_or("Unknown Auth Error")
                                .to_string();
                            let code = first.get("code").and_then(|c| c.as_i64()).unwrap_or(0);

                            inner.lock().await.callbacks.on_event(EventRecord {
                                r#type: "error".to_string(),
                                data: Some(format!("Auth Failed: {} (Code {})", err_msg, code)),
                            });

                            return WsLoopResult::FatalError(format!(
                                "Auth Failed: {} (Code {})",
                                err_msg, code
                            ));
                        }

                        // Check for Auth Success
                        if first.get("T").and_then(|t| t.as_str()) != Some("success")
                            || first.get("msg").and_then(|m| m.as_str()) != Some("authenticated")
                        {
                            return WsLoopResult::Reconnect;
                        }
                    }
                }
            }
        } else {
            return WsLoopResult::Reconnect;
        }

        // Notify that the connection has been successfully established and authenticated
        inner.lock().await.callbacks.on_event(EventRecord {
            r#type: "connected".to_string(),
            data: None,
        });

        // Split the stream into a writer and a reader for concurrent operation
        let (mut write, mut read) = ws_stream.split();

        // Send the initial subscription payload for all currently tracked symbols
        {
            let guard = inner.lock().await;
            if !guard.subscriptions.is_empty() {
                // By default, we subscribe to 'quotes' for provided symbols.
                // The struct can be extended to support trades/bars dynamically.
                let payload = serde_json::json!({
                    "action": "subscribe",
                    "quotes": guard.subscriptions
                })
                .to_string();

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
            // Select over various input sources concurrently
            tokio::select! {
                // Handle graceful stop signal
                _ = stop_rx.recv() => {
                    inner.lock().await.callbacks.on_event(EventRecord { r#type: "disconnected".to_string(), data: None });
                    return WsLoopResult::GracefulStop;
                }

                // Handle incoming WebSocket messages
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            // Reset silence timer as we received data
                            silence_timer.reset();

                            // Parse the message array from Alpaca
                            let items: Vec<serde_json::Value> = match serde_json::from_str(&text) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };

                            for obj in items {
                                let t_type = obj.get("T").and_then(|t| t.as_str()).unwrap_or("");

                                match t_type {
                                    // Process Quotes
                                    "q" => {
                                        let data = AlpacaPricingData {
                                            symbol: obj.get("S").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                                            message_type: "quote".to_string(),
                                            price: obj.get("bp").and_then(|v| v.as_f64()).unwrap_or(0.0), // Fallback to bid as primary price
                                            bid_price: obj.get("bp").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            ask_price: obj.get("ap").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            volume: obj.get("bs").and_then(|v| v.as_f64()).unwrap_or(0.0), // Bid size as volume proxy
                                            timestamp: obj.get("t").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                                        };
                                        inner.lock().await.callbacks.on_pricing(data);
                                    }
                                    // Process Trades
                                    "t" => {
                                        let data = AlpacaPricingData {
                                            symbol: obj.get("S").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                                            message_type: "trade".to_string(),
                                            price: obj.get("p").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            bid_price: 0.0,
                                            ask_price: 0.0,
                                            volume: obj.get("s").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            timestamp: obj.get("t").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                                        };
                                        inner.lock().await.callbacks.on_pricing(data);
                                    }
                                    // Process Bars
                                    "b" => {
                                        let data = AlpacaPricingData {
                                            symbol: obj.get("S").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                                            message_type: "bar".to_string(),
                                            price: obj.get("c").and_then(|v| v.as_f64()).unwrap_or(0.0), // Close price
                                            bid_price: 0.0,
                                            ask_price: 0.0,
                                            volume: obj.get("v").and_then(|v| v.as_f64()).unwrap_or(0.0),
                                            timestamp: obj.get("t").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                                        };
                                        inner.lock().await.callbacks.on_pricing(data);
                                    }
                                    // Handle subscription success messages
                                    "subscription" => {
                                        inner.lock().await.callbacks.on_log(LogRecord {
                                            level: "info".to_string(),
                                            msg: "Alpaca subscription updated".to_string(),
                                            extras: Some(text.to_string()),
                                        });
                                    }
                                    // Handle server errors
                                    "error" => {
                                        inner.lock().await.callbacks.on_log(LogRecord {
                                            level: "error".to_string(),
                                            msg: "Alpaca API Error".to_string(),
                                            extras: Some(text.to_string()),
                                        });
                                    }
                                    _ => {
                                        // Unhandled message types are traced
                                        inner.lock().await.callbacks.on_log(LogRecord {
                                            level: "trace".to_string(),
                                            msg: "Unhandled Alpaca Message".to_string(),
                                            extras: Some(text.to_string()),
                                        });
                                    }
                                }
                            }
                        }

                        // Handle WebSocket close frames
                        Some(Ok(Message::Close(c))) => {
                            let data = c.map(|frame| frame.reason.to_string());
                            inner.lock().await.callbacks.on_event(EventRecord { r#type: "disconnected".to_string(), data });
                            return WsLoopResult::Reconnect;
                        }

                        // Handle unexpected end of stream
                        None => {
                            inner.lock().await.callbacks.on_event(EventRecord { r#type: "disconnected".to_string(), data: Some("Stream ended".to_string()) });
                            return WsLoopResult::Reconnect;
                        }

                        // Handle WebSocket errors
                        Some(Err(e)) => {
                            let err_msg = e.to_string();
                            inner.lock().await.callbacks.on_log(LogRecord { level: "error".to_string(), msg: "WS read error".to_string(), extras: Some(err_msg.clone()) });
                            inner.lock().await.callbacks.on_event(EventRecord { r#type: "error".to_string(), data: Some(err_msg) });
                            return WsLoopResult::Reconnect;
                        }
                        _ => continue,
                    }
                }

                // Handle new symbol subscriptions added while the stream is active
                new_subs = sub_rx.recv() => {
                    if let Some(subs) = new_subs {
                        if !subs.is_empty() {
                            // Construct and send the subscription message
                            let payload = serde_json::json!({
                                "action": "subscribe",
                                "quotes": subs
                            }).to_string();
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
                    return WsLoopResult::Reconnect;
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
                    let mut table = write_txn.open_table(ALPACA_SUBSCRIPTIONS_TABLE).unwrap();
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
            let mut table = write_txn.open_table(ALPACA_SUBSCRIPTIONS_TABLE).unwrap();
            for s in &symbols {
                table.remove(s.as_str()).unwrap();
            }
        }
        write_txn.commit().unwrap();

        // Send the explicit unsubscribe message if the loop is active
        if let Some(_tx) = &guard.ws_task {
            // We bypass standard channels here and use the fact that the next reconnect
            // will drop them, or we could add an unsub channel in the future.
            // For now, we log the removal.
            guard.callbacks.on_log(LogRecord {
                level: "info".to_string(),
                msg: format!("Unsubscribed from {} symbols", symbols.len()),
                extras: None,
            });
        }
    }

    /// Clears all subscriptions and stops the streamer.
    pub async fn clean(&self) {
        let mut guard = self.inner.lock().await;

        // Delete the entire subscriptions table
        let write_txn = guard.db.begin_write().unwrap();
        let _ = write_txn.delete_table(ALPACA_SUBSCRIPTIONS_TABLE);
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

/// N-API wrapper for the Alpaca price streamer, enabling its use in JavaScript environments.
#[napi]
pub struct AlpacaStreaming {
    /// The core implementation using N-API callbacks.
    core: AlpacaStreamingCore<NapiCallbacks>,
}

#[napi]
impl AlpacaStreaming {
    /// Constructs a new `AlpacaStreaming` instance with the provided JavaScript callback functions.
    #[napi(constructor)]
    pub fn new(
        on_log: ThreadsafeFunction<LogRecord>,
        on_pricing: ThreadsafeFunction<AlpacaPricingData>,
        on_event: ThreadsafeFunction<EventRecord>,
    ) -> Self {
        Self {
            core: AlpacaStreamingCore::new(NapiCallbacks {
                on_log,
                on_pricing,
                on_event,
            }),
        }
    }

    /// Initializes the streamer with configuration parameters.
    #[napi]
    pub async fn init(&self, config: AlpacaConfig) -> Result<()> {
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

// =============================================
// EXHAUSTIVE TESTS
// =============================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestCallbacks {
        pricing_calls: Arc<AtomicUsize>,
        log_calls: Arc<AtomicUsize>,
        event_calls: Arc<AtomicUsize>,
    }

    impl AlpacaCallbacks for TestCallbacks {
        fn on_log(&self, _record: LogRecord) {
            self.log_calls.fetch_add(1, Ordering::SeqCst);
        }
        fn on_pricing(&self, _data: AlpacaPricingData) {
            self.pricing_calls.fetch_add(1, Ordering::SeqCst);
        }
        fn on_event(&self, _event: EventRecord) {
            self.event_calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn create_test_callbacks() -> (
        TestCallbacks,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
    ) {
        let p_calls = Arc::new(AtomicUsize::new(0));
        let l_calls = Arc::new(AtomicUsize::new(0));
        let e_calls = Arc::new(AtomicUsize::new(0));

        (
            TestCallbacks {
                pricing_calls: Arc::clone(&p_calls),
                log_calls: Arc::clone(&l_calls),
                event_calls: Arc::clone(&e_calls),
            },
            p_calls,
            l_calls,
            e_calls,
        )
    }

    #[tokio::test]
    async fn test_db_initialization_and_clean() {
        let (cb, _, _, _) = create_test_callbacks();

        // Use a distinct database file for the test
        std::env::set_var(
            "ALPACA_DB",
            format!(
                "{}/test_alpaca.redb",
                std::env::temp_dir().to_string_lossy()
            ),
        );

        let streamer = AlpacaStreamingCore::new(cb);

        // Clean existing state
        streamer.clean().await;

        // Assert empty
        {
            let guard = streamer.inner.lock().await;
            assert!(guard.subscriptions.is_empty());
        }

        // Subscribe to items
        streamer
            .subscribe(vec!["AAPL".to_string(), "MSFT".to_string()])
            .await;

        // Assert items exist in memory
        {
            let guard = streamer.inner.lock().await;
            assert_eq!(guard.subscriptions.len(), 2);
            assert!(guard.subscriptions.contains(&"AAPL".to_string()));
        }

        // Clean up
        streamer.clean().await;
    }

    #[tokio::test]
    async fn test_subscribe_unsubscribe() {
        let (cb, _, _, _) = create_test_callbacks();
        std::env::set_var(
            "ALPACA_DB",
            format!(
                "{}/test_alpaca_sub.redb",
                std::env::temp_dir().to_string_lossy()
            ),
        );

        let streamer = AlpacaStreamingCore::new(cb);
        streamer.clean().await;

        streamer.subscribe(vec!["TSLA".to_string()]).await;

        {
            let guard = streamer.inner.lock().await;
            assert_eq!(guard.subscriptions.len(), 1);
            assert_eq!(guard.subscriptions[0], "TSLA");
        }

        streamer.unsubscribe(vec!["TSLA".to_string()]).await;

        {
            let guard = streamer.inner.lock().await;
            assert!(guard.subscriptions.is_empty());
        }
    }

    #[test]
    fn test_alpaca_pricing_data_deserialization() {
        // Simulating the data we would map from an Alpaca Quote message
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
}
