// =============================================
// FILE: rust/src/bin/nasdaq_polling.rs
// PURPOSE: Persistent daemon for polling Nasdaq quotes.
// DESCRIPTION: This binary operates as a daemon that polls Nasdaq quotes based on
// a complex cron schedule. It supports direct retrieval with concurrency limits
// or load-balanced retrieval via ts-cloud edge proxies. Output is formatted as NDJSON.
// =============================================

use clap::Parser;
use corelib_rust::markets::nasdaq::api_nasdaq_quotes::{self, AssetClass};
use corelib_rust::retrieve::proxied::RequestProxied;
use corelib_rust::retrieve::unlimited::{ApiResponse, SerializedResponse};
use corelib_rust::utils::include_exclude_cron;
use serde_json::json;
use std::collections::HashMap;
use std::io::{self, Write};
use std::str::FromStr;
use tokio::sync::mpsc;

/// Command-line arguments for the Nasdaq Polling daemon.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    /// Cron expressions that trigger the polling execution (e.g., "* * * * * * *").
    #[arg(short, long = "include", required = true)]
    pub include_exprs: Vec<String>,

    /// Cron expressions that prevent the polling execution.
    #[arg(short = 'x', long = "exclude")]
    pub exclude_exprs: Vec<String>,

    /// Symbols to monitor, formatted as "SYMBOL::assetclass" (e.g., "AAPL::stocks").
    #[arg(short, long = "symbol", required = true)]
    pub symbol: Vec<String>,

    /// Optional ts-cloud proxy URLs for load-balanced retrieval.
    #[arg(short, long = "proxy")]
    pub proxy: Vec<String>,

    /// Concurrency limit for direct (non-proxied) Nasdaq API requests.
    #[arg(short, long, default_value_t = 5)]
    pub concurrency: usize,
}

/// Parses and validates a symbol input string.
///
/// # Arguments
/// * `input` - The formatted string to parse (e.g., `"AAPL::stocks"`).
///
/// # Returns
/// A `Result` containing a tuple of the uppercase symbol and parsed `AssetClass`.
pub fn parse_symbol(input: &str) -> Result<(String, AssetClass), String> {
    // Split the input into symbol and asset class
    let parts: Vec<&str> = input.split("::").collect();
    if parts.len() != 2 {
        return Err(format!(
            "Invalid format for '{}'. Expected 'SYMBOL::assetclass'",
            input
        ));
    }

    // Uppercase the symbol to normalize it
    let sym = parts[0].to_uppercase();
    // Parse the asset class utilizing the corelib enum
    let class = AssetClass::from_str(parts[1])?;

    Ok((sym, class))
}

/// Maps a raw Nasdaq quote result to the standard `ApiResponse` (RequestResult) schema.
///
/// # Arguments
/// * `result` - The `Result` returned from `api_nasdaq_quotes`.
/// * `url` - The original URL that was requested (for contextual metadata).
///
/// # Returns
/// An `ApiResponse<serde_json::Value>` conforming to the expected JSON NDJSON output.
pub fn map_direct_result_to_api_response(
    result: Result<serde_json::Value, String>,
    url: String,
) -> ApiResponse<serde_json::Value> {
    match result {
        Ok(val) => ApiResponse::Success {
            value: SerializedResponse {
                ok: true,
                status: 200,
                status_text: "OK".to_string(),
                headers: HashMap::new(),
                url,
                body: val,
            },
        },
        Err(err) => ApiResponse::Error {
            reason: json!({ "message": err, "url": url }),
        },
    }
}

/// The main entry point for the Nasdaq polling daemon.
#[tokio::main]
async fn main() {
    // Parse command line arguments
    let args = Args::parse();

    // Prepare URL and validation structures
    let mut target_urls = Vec::new();
    let mut valid_symbols = Vec::new();

    // Validate all symbols before starting the daemon
    for sym_input in &args.symbol {
        match parse_symbol(sym_input) {
            Ok((sym, class)) => {
                // Store the validated input for direct fetching
                valid_symbols.push(sym_input.clone());
                // Construct the target URL for proxied fetching
                let url = format!(
                    "https://api.nasdaq.com/api/quote/{}/info?assetclass={}",
                    sym, class
                );
                target_urls.push(url);
            }
            Err(e) => {
                // Halt execution if any symbol is incorrectly formatted
                eprintln!("[ERROR] Validation Failed: {}", e);
                std::process::exit(1);
            }
        }
    }

    let url_refs: Vec<&str> = target_urls.iter().map(|s| s.as_str()).collect();
    let sym_refs: Vec<&str> = valid_symbols.iter().map(|s| s.as_str()).collect();
    let use_proxies = !args.proxy.is_empty();

    // Initialize the proxy client if proxies are provided
    let proxied_client = if use_proxies {
        Some(RequestProxied::new(args.proxy.clone()))
    } else {
        None
    };

    // Create a channel to communicate between the cron thread and the async runtime
    let (tx, mut rx) = mpsc::channel::<()>(1);

    eprintln!("[INFO] Initializing cron scheduler...");

    // Start the background cron thread
    let _cron_handle = include_exclude_cron::include_exclude_cron(
        args.include_exprs.clone(),
        args.exclude_exprs.clone(),
        move || {
            // Signal the async runtime to execute a poll
            if tx.blocking_send(()).is_err() {
                eprintln!("[WARN] Failed to send cron trigger signal.");
            }
        },
    );

    eprintln!(
        "[INFO] Daemon started successfully. Monitoring {} symbol(s).",
        valid_symbols.len()
    );
    eprintln!(
        "[INFO] Execution strategy: {}",
        if use_proxies { "ts-cloud Edge Proxies" } else { "Direct API Fallback" }
    );

    // Persistent daemon loop listening for cron ticks
    while rx.recv().await.is_some() {
        let results = if let Some(ref client) = proxied_client {
            // Execute load-balanced requests across ts-cloud edge proxies
            client
                .end_points::<serde_json::Value>(&url_refs, "/api/v1/markets/nasdaq", None)
                .await
        } else {
            // Execute direct Nasdaq API requests with concurrency limit
            let direct_quotes =
                api_nasdaq_quotes::nasdaq_quotes(&sym_refs, args.concurrency).await;
            
            // Map the raw results to the standardized ApiResponse format
            direct_quotes
                .into_iter()
                .enumerate()
                .map(|(i, res)| map_direct_result_to_api_response(res, target_urls[i].clone()))
                .collect()
        };

        // Output results to stdout as NDJSON
        for res in results {
            match serde_json::to_string(&res) {
                Ok(json_str) => {
                    println!("{}", json_str);
                }
                Err(e) => {
                    eprintln!("[ERROR] Serialization failed for result: {}", e);
                }
            }
        }

        // Flush stdout to ensure real-time log ingestion systems receive data immediately
        if let Err(e) = io::stdout().flush() {
            eprintln!("[ERROR] Failed to flush stdout: {}", e);
        }
    }
}

// =============================================
// EXHAUSTIVE TESTS
// =============================================

#[cfg(test)]
mod tests {
    use super::*;
    use corelib_rust::markets::nasdaq::api_nasdaq_quotes::AssetClass;

    #[test]
    fn test_parse_symbol_valid_stock() {
        let result = parse_symbol("AAPL::stocks");
        assert!(result.is_ok());
        let (sym, class) = result.unwrap();
        assert_eq!(sym, "AAPL");
        assert_eq!(class, AssetClass::Stocks);
    }

    #[test]
    fn test_parse_symbol_valid_etf_mixed_case() {
        let result = parse_symbol("qqq::EtF");
        assert!(result.is_ok());
        let (sym, class) = result.unwrap();
        assert_eq!(sym, "QQQ");
        assert_eq!(class, AssetClass::Etf);
    }

    #[test]
    fn test_parse_symbol_invalid_format() {
        let result = parse_symbol("AAPL");
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "Invalid format for 'AAPL'. Expected 'SYMBOL::assetclass'"
        );
    }

    #[test]
    fn test_parse_symbol_invalid_class() {
        let result = parse_symbol("AAPL::options");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Unknown AssetClass: options");
    }

    #[test]
    fn test_map_direct_result_to_api_response_success() {
        let mock_val = json!({"price": 150.0});
        let url = "https://api.nasdaq.com/fake".to_string();
        let mapped = map_direct_result_to_api_response(Ok(mock_val.clone()), url.clone());

        match mapped {
            ApiResponse::Success { value } => {
                assert_eq!(value.status, 200);
                assert!(value.ok);
                assert_eq!(value.url, url);
                assert_eq!(value.body, mock_val);
            }
            _ => panic!("Expected ApiResponse::Success"),
        }
    }

    #[test]
    fn test_map_direct_result_to_api_response_error() {
        let error_msg = "Rate limit exceeded".to_string();
        let url = "https://api.nasdaq.com/fake".to_string();
        let mapped = map_direct_result_to_api_response(Err(error_msg.clone()), url.clone());

        match mapped {
            ApiResponse::Error { reason } => {
                assert_eq!(reason["message"], error_msg);
                assert_eq!(reason["url"], url);
            }
            _ => panic!("Expected ApiResponse::Error"),
        }
    }

    #[test]
    fn test_args_parsing_defaults() {
        // Using clap to parse arguments from an array to verify defaults and structures
        let args = Args::try_parse_from(&[
            "nasdaq_polling",
            "--include",
            "* * * * * * *",
            "--symbol",
            "AAPL::stocks",
        ])
        .unwrap();

        assert_eq!(args.include_exprs.len(), 1);
        assert_eq!(args.include_exprs[0], "* * * * * * *");
        assert!(args.exclude_exprs.is_empty());
        assert_eq!(args.symbol.len(), 1);
        assert_eq!(args.symbol[0], "AAPL::stocks");
        assert!(args.proxy.is_empty());
        assert_eq!(args.concurrency, 5); // Default value
    }

    #[test]
    fn test_args_parsing_full() {
        let args = Args::try_parse_from(&[
            "nasdaq_polling",
            "-i",
            "*/5 * * * * * *",
            "-x",
            "* * * * * 0,6 *", // Exclude weekends
            "-s",
            "MSFT::stocks",
            "-s",
            "QQQ::etf",
            "-p",
            "https://proxy1.com",
            "-p",
            "https://proxy2.com",
            "-c",
            "10",
        ])
        .unwrap();

        assert_eq!(args.include_exprs[0], "*/5 * * * * * *");
        assert_eq!(args.exclude_exprs[0], "* * * * * 0,6 *");
        assert_eq!(args.symbol, vec!["MSFT::stocks", "QQQ::etf"]);
        assert_eq!(args.proxy, vec!["https://proxy1.com", "https://proxy2.com"]);
        assert_eq!(args.concurrency, 10);
    }
}
