use clap::Parser;
use corelib_rust::{RustCallbacks, YahooConfig, YahooStreamingCore};
use std::io::{self, Write};

#[derive(Parser)]
struct Args {
    #[arg(short, long)]
    symbols: Option<String>,
    #[arg(short, long, default_value = "60")]
    silence: u32,
    #[arg(long)]
    clean: bool,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    let callbacks = RustCallbacks {
        on_log: Box::new(|log| {
            let extras = log.extras.unwrap_or_else(|| "{}".to_string());
            eprintln!("[LOG] {}: {} {}", log.level, log.msg, extras);
        }),
        on_pricing: Box::new(|pricing| {
            if let Ok(json) = serde_json::to_string(&pricing) {
                println!("{}", json);
                let _ = io::stdout().flush();
            }
        }),
        on_event: Box::new(|event| {
            let data = event.data.unwrap_or_else(|| "null".to_string());
            eprintln!("[EVENT] {} {}", event.r#type, data);
        }),
    };

    let streamer = YahooStreamingCore::new(callbacks);

    streamer
        .init(YahooConfig {
            db_path: None,
            silence_seconds: Some(args.silence),
        })
        .await;

    if args.clean {
        eprintln!("Cleaning subscriptions...");
        streamer.clean().await;
        if args.symbols.is_none() {
            eprintln!("Done.");
            return;
        }
    }

    if let Some(s) = args.symbols {
        let symbols: Vec<String> = s.split(',').map(|s| s.trim().to_string()).collect();
        streamer.subscribe(symbols).await;
    }

    streamer.start().await;

    eprintln!("Streaming started. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c().await.unwrap();
    eprintln!("Stopping...");
    streamer.stop().await;
}
