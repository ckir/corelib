//! Boundary lint: the streaming ENGINE source set must contain NO direct napi coupling.
//! The only permitted napi mention is the `cfg_attr(feature = "napi", …)` derive on wire types.
//! This stands in for the `--no-default-features` compile check we cannot run in a single crate
//! (the facades + non-streaming code require napi unconditionally — see lib.rs compile_error!).
use std::fs;
use std::path::Path;

/// Engine source files (relative to the crate root) that MUST stay napi-free.
const ENGINE_FILES: &[&str] = &[
    "src/markets/nasdaq/datafeeds/streaming/core/driver.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/host.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/reconnect.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/schema.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/supervisor.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/mod.rs",
    "src/markets/nasdaq/datafeeds/streaming/core/types.rs",
    "src/markets/nasdaq/datafeeds/streaming/alpaca/alpaca_driver.rs",
    "src/markets/nasdaq/datafeeds/streaming/finnhub/finnhub_driver.rs",
    "src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_driver.rs",
    "src/markets/nasdaq/datafeeds/streaming/yahoo/yahoo_streaming_proto_handler.rs",
];

/// Strip `//` line comments, `/* */` block comments, and "double-quoted" string literals,
/// so the napi-token scan sees code only (avoids false positives on docs/log strings).
/// Preserves line count (one `\n` per input line) so reported line numbers stay accurate.
fn strip_noise(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut in_block = false;
    let mut in_str = false; // persists across lines (Rust string literals can span lines)
    for line in src.lines() {
        let b = line.as_bytes();
        let mut i = 0usize;
        while i < b.len() {
            if in_block {
                if i + 1 < b.len() && b[i] == b'*' && b[i + 1] == b'/' {
                    in_block = false;
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if in_str {
                if b[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if b[i] == b'"' {
                    in_str = false;
                }
                i += 1;
                continue;
            }
            if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'/' {
                break; // rest of line is a comment
            }
            if i + 1 < b.len() && b[i] == b'/' && b[i + 1] == b'*' {
                in_block = true;
                i += 2;
                continue;
            }
            if b[i] == b'"' {
                in_str = true;
                i += 1;
                continue;
            }
            out.push(b[i] as char);
            i += 1;
        }
        out.push('\n');
    }
    out
}

#[test]
fn engine_source_has_no_direct_napi_coupling() {
    let root = env!("CARGO_MANIFEST_DIR");
    let forbidden = ["use napi", "napi::", "#[napi", "napi_derive"];
    let mut violations: Vec<String> = Vec::new();
    for rel in ENGINE_FILES {
        let path = Path::new(root).join(rel);
        let src = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("engine file unreadable: {rel}: {e}"));
        let cleaned = strip_noise(&src);
        for (n, (raw_line, clean_line)) in src.lines().zip(cleaned.lines()).enumerate() {
            // The single allowlisted exception: the cfg_attr napi gate on wire types.
            if raw_line.contains("cfg_attr") && raw_line.contains("\"napi\"") {
                continue;
            }
            for pat in &forbidden {
                if clean_line.contains(pat) {
                    violations.push(format!("{rel}:{}: `{pat}` in `{}`", n + 1, raw_line.trim()));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "streaming engine files must be napi-free (cfg_attr gate is the only exception):\n{}",
        violations.join("\n")
    );
}
