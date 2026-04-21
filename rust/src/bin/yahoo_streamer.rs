// =============================================
// FILE: rust/src/bin/yahoo_streamer.rs
// PURPOSE: CLI entry point for the Yahoo Finance price streamer.
// DESCRIPTION: This binary allows running the Yahoo price streamer from the
// command line. It supports symbol subscription, persistence via a local database,
// and outputs real-time pricing data as JSON to stdout.
// =============================================

use clap::Parser;
use corelib_rust::{RustCallbacks, YahooConfig, YahooStreamingCore};
use std::io::{self, Write};

/// Command-line arguments for the Yahoo streamer CLI.
#[derive(Parser)]
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
}

#[tokio::main]
async fn main() {
    // Parse command-line arguments using clap
    let args = Args::parse();

    // Define the native Rust callbacks for handling logs, pricing data, and events
    let callbacks = RustCallbacks {
        on_log: Box::new(|log| {
            // Log messages to stderr to keep stdout clean for data piping
            let extras = log.extras.unwrap_or_else(|| "{}".to_string());
            eprintln!("[LOG] {}: {} {}", log.level, log.msg, extras);
        }),
        on_pricing: Box::new(|pricing| {
            // Output successfully decoded pricing updates as JSON to stdout
            if let Ok(json) = serde_json::to_string(&pricing) {
                println!("{}", json);
                // Ensure the output is flushed immediately
                let _ = io::stdout().flush();
            }
        }),
        on_event: Box::new(|event| {
            // Log lifecycle events to stderr
            let data = event.data.unwrap_or_else(|| "null".to_string());
            eprintln!("[EVENT] {} {}", event.r#type, data);
        }),
    };

    // Create the streamer core with the defined callbacks
    let streamer = YahooStreamingCore::new(callbacks);

    // Initialize the streamer with CLI-provided configuration
    streamer
        .init(YahooConfig {
            db_path: None, // Use default database path
            silence_seconds: Some(args.silence),
        })
        .await;

    // Handle the --clean flag if provided
    if args.clean {
        eprintln!("Cleaning subscriptions...");
        streamer.clean().await;
        // If no new symbols were provided, exit after cleaning
        if args.symbols.is_none() {
            eprintln!("Done.");
            return;
        }
    }

    // Subscribe to new symbols provided via the --symbols argument
    if let Some(s) = args.symbols {
        let symbols: Vec<String> = s.split(',').map(|s| s.trim().to_string()).collect();
        streamer.subscribe(symbols).await;
    }

    // Start the background streaming task
    streamer.start().await;

    eprintln!("Streaming started. Press Ctrl+C to stop.");
    // Wait for a termination signal (Ctrl+C)
    tokio::signal::ctrl_c().await.unwrap();
    eprintln!("Stopping...");
    // Gracefully stop the streamer before exiting
    streamer.stop().await;
}
