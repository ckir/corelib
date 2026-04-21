use clap::Parser;
use corelib_rust::markets::nasdaq::datafeeds::streaming::alpaca::alpaca_streamer::AlpacaCallbacks;
use corelib_rust::{AlpacaConfig, AlpacaPricingData, AlpacaStreamingCore, EventRecord, LogRecord};
use std::env;

struct StdOutCallbacks;

impl AlpacaCallbacks for StdOutCallbacks {
    fn on_log(&self, record: LogRecord) {
        eprintln!(
            "[{}] {} {}",
            record.level.to_uppercase(),
            record.msg,
            record.extras.unwrap_or_default()
        );
    }

    fn on_pricing(&self, data: AlpacaPricingData) {
        if let Ok(json) = serde_json::to_string(&data) {
            println!("{}", json);
        }
    }

    fn on_event(&self, event: EventRecord) {
        eprintln!(
            "[EVENT] {} {}",
            event.r#type.to_uppercase(),
            event.data.unwrap_or_default()
        );
    }
}

/// Command-line arguments for the Alpaca streamer CLI.
#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Comma-separated list of symbols to subscribe to (e.g., "AAPL,MSFT,TSLA").
    #[arg(short, long)]
    symbols: Option<String>,

    /// Alpaca API Key ID (overrides APCA_API_KEY_ID env var).
    #[arg(short, long)]
    key: Option<String>,

    /// Alpaca API Secret Key (overrides APCA_API_SECRET_KEY env var).
    #[arg(long)]
    secret: Option<String>,

    /// Threshold in seconds for silence detection before reconnecting.
    #[arg(long, default_value = "60")]
    silence: u32,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Parse command line arguments using clap
    let args = Args::parse();

    // Determine the API Key: CLI flag strictly overrides the Environment Variable
    let key = args
        .key
        .or_else(|| env::var("APCA_API_KEY_ID").ok())
        .expect("Fatal: Missing APCA_API_KEY_ID in environment and --key CLI argument");

    // Determine the Secret Key: CLI flag strictly overrides the Environment Variable
    let secret = args
        .secret
        .or_else(|| env::var("APCA_API_SECRET_KEY").ok())
        .expect("Fatal: Missing APCA_API_SECRET_KEY in environment and --secret CLI argument");

    // Parse the comma-separated symbols into a collection
    let symbols: Vec<String> = args
        .symbols
        .map(|s| s.split(',').map(|item| item.trim().to_string()).collect())
        .unwrap_or_default();

    // Output initialization lifecycle event strictly to stderr
    eprintln!("Initializing Alpaca Streamer binary...");

    // Initialize the core streaming struct with the resolved credentials
    let streamer = AlpacaStreamingCore::new(StdOutCallbacks);

    // Initialize with config
    streamer
        .init(AlpacaConfig {
            db_path: None,
            silence_seconds: Some(args.silence),
            base_url: None,
            key_id: Some(key),
            secret_key: Some(secret),
        })
        .await;

    // Bootstrap the asynchronous streaming connection
    streamer.start().await;

    // Conditionally execute the subscription payload
    if !symbols.is_empty() {
        // Dispatch the parsed symbols to the active WebSocket
        streamer.subscribe(symbols).await;
    } else {
        // Emit a warning to stderr to alert the user of an idle stream
        eprintln!(
            "Warning: No symbols provided. Streamer is running but idle. Use --symbols=AAPL,MSFT"
        );
    }

    // Keep the asynchronous runtime alive to process incoming WebSocket frames
    loop {
        // Sleep the thread in intervals to yield execution back to Tokio
        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
    }
}
