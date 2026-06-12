use clap::Parser;
use corelib_rust::markets::nasdaq::datafeeds::streaming::alpaca::alpaca_driver::AlpacaDriver;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::host::{
    unique_db_path, WebsocketStreamerHost,
};
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use std::env;

/// Command-line arguments for the Alpaca streamer CLI.
#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Comma-separated list of symbols to subscribe to (e.g., "AAPL,MSFT,TSLA"). Subscribed on
    /// the `quotes` channel for back-compat.
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

    /// Optional path to the persistence database (maps to the ALPACA_DB env override).
    #[arg(long)]
    db: Option<String>,

    /// If set, skips stable persistence (uses an ephemeral per-run db file).
    #[arg(long = "noPersist")]
    no_persist: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    // Resolve the redb path the host will use (via the ALPACA_DB override read by unique_db_path):
    //   --db <path>            → that path
    //   default (persist)      → a stable temp file
    //   --noPersist            → leave unset → unique ephemeral per-run file
    if let Some(db) = &args.db {
        std::env::set_var("ALPACA_DB", db);
    } else if !args.no_persist {
        let mut p = std::env::temp_dir();
        p.push("alpaca_streamer.db");
        std::env::set_var("ALPACA_DB", p.to_string_lossy().to_string());
    }

    // Credentials: CLI flag strictly overrides the environment variable.
    let key = args
        .key
        .or_else(|| env::var("APCA_API_KEY_ID").ok())
        .expect("Fatal: Missing APCA_API_KEY_ID in environment and --key CLI argument");
    let secret = args
        .secret
        .or_else(|| env::var("APCA_API_SECRET_KEY").ok())
        .expect("Fatal: Missing APCA_API_SECRET_KEY in environment and --secret CLI argument");

    let symbols: Vec<String> = args
        .symbols
        .clone()
        .map(|s| {
            s.split(',')
                .map(|item| item.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect()
        })
        .unwrap_or_default();

    eprintln!("Initializing Alpaca Streamer binary...");

    let mut host = WebsocketStreamerHost::new(
        unique_db_path("alpaca_streaming", "ALPACA_DB"),
        "alpaca_subscriptions",
        "alpaca".into(),
        ProviderKind::Alpaca,
    );

    if args.clean {
        eprintln!("Cleaning subscriptions...");
        let _ = host.delete_subscriptions_table();
        if args.symbols.is_none() {
            eprintln!("Done.");
            return Ok(());
        }
    }

    // Pre-seed persisted subscriptions (the driver resumes these from redb on connect).
    if !symbols.is_empty() {
        host.subscribe_channel("quotes", symbols.clone());
    }

    let driver = AlpacaDriver {
        name: "alpaca".into(),
        base_url: env::var("APCA_API_BASE_URL").ok(),
        key_id: key,
        secret_key: secret,
        silence_seconds: args.silence,
        db: host.db_handle(),
        table: host.table_name(),
    };

    host.start(
        driver,
        Vec::new(),
        ReconnectPolicy {
            jitter: true,
            ..Default::default()
        },
        |ev: CoreEvent| match ev {
            CoreEvent::Pricing {
                raw: RawPricing::Alpaca(p),
                ..
            } => {
                if let Ok(json) = serde_json::to_string(&p) {
                    println!("{json}");
                }
            }
            CoreEvent::Status(s) => eprintln!("[EVENT] {s:?}"),
            _ => {}
        },
    );

    if symbols.is_empty() {
        eprintln!(
            "Warning: No symbols provided. Streamer is running but idle. Use --symbols=AAPL,MSFT"
        );
    }
    eprintln!("Streaming started. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c().await.unwrap();
    eprintln!("Stopping...");
    // `host` drops here → supervisor stops (stop_tx) and monitor/pump tasks abort.
    Ok(())
}
