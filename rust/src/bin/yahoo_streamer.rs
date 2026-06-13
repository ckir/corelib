// =============================================
// FILE: rust/src/bin/yahoo_streamer.rs
// PURPOSE: CLI entry point for the Yahoo Finance price streamer.
// DESCRIPTION: Drives a YahooDriver on the shared WebsocketStreamerHost. Outputs
// raw decoded pricing data as JSON lines to stdout; lifecycle status to stderr.
// =============================================

use clap::Parser;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::host::{
    unique_db_path, WebsocketStreamerHost,
};
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::reconnect::ReconnectPolicy;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::schema::ProviderKind;
use corelib_rust::markets::nasdaq::datafeeds::streaming::core::types::{CoreEvent, RawPricing};
use corelib_rust::markets::nasdaq::datafeeds::streaming::yahoo::yahoo_driver::YahooDriver;
use std::io::{self, Write};

/// Command-line arguments for the Yahoo streamer CLI.
#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Comma-separated list of symbols to subscribe to (e.g., "AAPL,MSFT,TSLA").
    #[arg(short, long)]
    symbols: Option<String>,
    /// Threshold in seconds for silence detection before reconnecting.
    #[arg(long, default_value = "60")]
    silence: u32,
    /// If set, clears all existing persistent subscriptions before starting.
    #[arg(long)]
    clean: bool,
    /// Optional path to the persistence database (maps to the YAHOO_DB env override).
    #[arg(long)]
    db: Option<String>,
    /// If set, skips stable persistence (uses an ephemeral per-run db file).
    #[arg(long = "noPersist")]
    no_persist: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    // Resolve the redb path the host will use (via the YAHOO_DB override read by unique_db_path).
    if let Some(db) = &args.db {
        std::env::set_var("YAHOO_DB", db);
    } else if !args.no_persist {
        let mut p = std::env::temp_dir();
        p.push("yahoo_streamer.db");
        std::env::set_var("YAHOO_DB", p.to_string_lossy().to_string());
    }

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

    eprintln!("Initializing Yahoo Streamer binary...");

    let mut host = WebsocketStreamerHost::new(
        unique_db_path("yahoo_streaming", "YAHOO_DB"),
        "yahoo_subscriptions",
        "yahoo".into(),
        ProviderKind::Yahoo,
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
        host.subscribe(symbols.clone()).await;
    }

    let driver = YahooDriver {
        name: "yahoo".into(),
        base_url: None,
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
                raw: RawPricing::Yahoo(p),
                ..
            } => {
                if let Ok(json) = serde_json::to_string(&p) {
                    println!("{json}");
                    let _ = io::stdout().flush();
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
