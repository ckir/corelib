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

    /// If set, clears all existing persistent subscriptions before starting.
    #[arg(long)]
    clean: bool,

    /// Optional path to the persistence database.
    #[arg(long)]
    db: Option<String>,

    /// If set, skips database persistence entirely.
    #[arg(long = "noPersist")]
    no_persist: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Parse command line arguments using clap
    let args = Args::parse();

    // Determine the database path: CLI flag overrides environment variable
    let db_path = if args.no_persist {
        "NOT_SET".to_string()
    } else {
        args.db.unwrap_or_else(|| {
            let mut path = std::env::temp_dir();
            path.push("alpaca_streamer.db");
            path.to_string_lossy().to_string()
        })
    };
    // Set the environment variable used by AlpacaStreamingCore
    std::env::set_var("ALPACA_DB", &db_path);

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
        .clone()
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

    // Handle the --clean flag if provided
    if args.clean {
        eprintln!("Cleaning subscriptions...");
        streamer.clean().await;
        // If no new symbols were provided, exit after cleaning
        if args.symbols.is_none() {
            eprintln!("Done.");
            return Ok(());
        }
    }

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

    eprintln!("Streaming started. Press Ctrl+C to stop.");
    // Wait for a termination signal (Ctrl+C)
    tokio::signal::ctrl_c().await.unwrap();
    eprintln!("Stopping...");
    // Gracefully stop the streamer before exiting
    streamer.stop().await;

    Ok(())
}
