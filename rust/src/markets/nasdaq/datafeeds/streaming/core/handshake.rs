//! Bounded, stop-aware WebSocket connect + handshake-read helpers shared by the drivers.
//!
//! A black-holed peer (SYN accepted, nothing ever replied) would otherwise hang `connect_async`
//! or the greeting/auth `ws.next()` forever, ignoring `stop()` and `Drop`. Every helper here
//! races the operation against `stop_rx` and a deadline.
use futures_util::{Stream, StreamExt};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

/// Upper bound for the TCP/TLS/WebSocket upgrade, and separately for each handshake read.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a bounded handshake step did not produce a value.
#[derive(Debug, PartialEq, Eq)]
pub enum HandshakeError {
    /// The deadline elapsed.
    Timeout,
    /// `stop_rx` fired (or its sender was dropped) first.
    Stopped,
    /// Transport error / peer closed / non-text frame. Carries a client-side description only.
    Failed(String),
}

/// `connect_async` bounded by `timeout` and abortable via `stop_rx`.
pub async fn connect_with_stop(
    url: &str,
    stop_rx: &mut mpsc::Receiver<()>,
    timeout: Duration,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, HandshakeError> {
    tokio::select! {
        _ = stop_rx.recv() => Err(HandshakeError::Stopped),
        r = tokio::time::timeout(timeout, connect_async(url)) => match r {
            Err(_) => Err(HandshakeError::Timeout),
            Ok(Err(e)) => Err(HandshakeError::Failed(e.to_string())),
            Ok(Ok((ws, _))) => Ok(ws),
        },
    }
}

/// Read the next TEXT frame, skipping ping/pong, bounded by one overall `timeout` and
/// abortable via `stop_rx`. A close frame, stream end, transport error or binary frame is `Failed`.
pub async fn next_text_with_stop<S>(
    ws: &mut S,
    stop_rx: &mut mpsc::Receiver<()>,
    timeout: Duration,
) -> Result<String, HandshakeError>
where
    S: Stream<Item = Result<Message, WsError>> + Unpin,
{
    let deadline = Instant::now() + timeout;
    loop {
        let item = tokio::select! {
            _ = stop_rx.recv() => return Err(HandshakeError::Stopped),
            r = tokio::time::timeout_at(deadline, ws.next()) => match r {
                Err(_) => return Err(HandshakeError::Timeout),
                Ok(i) => i,
            },
        };
        match item {
            Some(Ok(Message::Text(t))) => return Ok(t.to_string()),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(_)) => return Err(HandshakeError::Failed("unexpected frame".into())),
            Some(Err(e)) => return Err(HandshakeError::Failed(e.to_string())),
            None => return Err(HandshakeError::Failed("connection closed".into())),
        }
    }
}

/// Validate a configured WebSocket endpoint: the scheme must be `ws`/`wss`, and plaintext `ws`
/// is only allowed for loopback hosts (credentials are sent over this connection).
///
/// An `http(s)://` URL is rejected (NOT rewritten to `ws(s)://`): such a value is almost always
/// Alpaca's REST base (`APCA_API_BASE_URL=https://paper-api.alpaca.markets`), whose host does not
/// serve the data stream, so a scheme rewrite would still connect to the wrong endpoint.
pub fn validate_ws_endpoint(url: &str) -> Result<(), String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| "base_url must be a ws:// or wss:// WebSocket URL".to_string())?;
    match scheme.to_ascii_lowercase().as_str() {
        "wss" => Ok(()),
        "ws" => {
            let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
            let hostport = authority.rsplit('@').next().unwrap_or("");
            let host = if let Some(v6) = hostport.strip_prefix('[') {
                v6.split(']').next().unwrap_or("")
            } else {
                hostport.split(':').next().unwrap_or("")
            };
            let loopback = host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback());
            if loopback {
                Ok(())
            } else {
                Err("plaintext ws:// is only allowed for loopback hosts; use wss:// (credentials are sent over this connection)".into())
            }
        }
        "http" | "https" => Err(format!(
            "base_url must be a ws:// or wss:// WebSocket URL, but an {scheme}:// URL was given \
             (APCA_API_BASE_URL is Alpaca's REST URL, not the data-stream WebSocket URL)"
        )),
        other => Err(format!(
            "base_url must be a ws:// or wss:// WebSocket URL (got scheme `{other}`)"
        )),
    }
}

/// Percent-encode `s` for use as a URL query component (RFC 3986 unreserved set is kept).
pub fn percent_encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::SinkExt;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    /// Accepts TCP connections and never replies (black hole).
    async fn black_hole() -> (String, TcpListener) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        (
            format!("ws://127.0.0.1:{}", l.local_addr().unwrap().port()),
            l,
        )
    }

    #[tokio::test]
    async fn connect_times_out_against_black_hole() {
        let (url, _l) = black_hole().await;
        let (_stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let r = connect_with_stop(&url, &mut stop_rx, Duration::from_millis(200)).await;
        assert_eq!(r.err(), Some(HandshakeError::Timeout));
    }

    #[tokio::test]
    async fn connect_returns_promptly_on_stop() {
        let (url, _l) = black_hole().await;
        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = stop_tx.send(()).await;
        });
        let t = std::time::Instant::now();
        let r = connect_with_stop(&url, &mut stop_rx, Duration::from_secs(30)).await;
        assert_eq!(r.err(), Some(HandshakeError::Stopped));
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn read_times_out_when_peer_never_speaks_and_stops_on_signal() {
        let (url, l) = black_hole().await;
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let _ws = accept_async(s).await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let mut ws = connect_with_stop(&url, &mut stop_rx, Duration::from_secs(5))
            .await
            .unwrap();
        let r = next_text_with_stop(&mut ws, &mut stop_rx, Duration::from_millis(200)).await;
        assert_eq!(r, Err(HandshakeError::Timeout));
        stop_tx.send(()).await.unwrap();
        let r = next_text_with_stop(&mut ws, &mut stop_rx, Duration::from_secs(30)).await;
        assert_eq!(r, Err(HandshakeError::Stopped));
    }

    #[tokio::test]
    async fn read_skips_ping_and_returns_text() {
        let (url, l) = black_hole().await;
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let mut ws = accept_async(s).await.unwrap();
            ws.send(Message::Ping(vec![].into())).await.unwrap();
            ws.send(Message::Text("hi".into())).await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let (_stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
        let mut ws = connect_with_stop(&url, &mut stop_rx, Duration::from_secs(5))
            .await
            .unwrap();
        let r = next_text_with_stop(&mut ws, &mut stop_rx, Duration::from_secs(5)).await;
        assert_eq!(r, Ok("hi".to_string()));
    }

    #[test]
    fn endpoint_validation_scheme_and_loopback() {
        for ok in [
            "wss://stream.data.alpaca.markets/v2/iex",
            "wss://ws.finnhub.io",
            "ws://127.0.0.1:9001",
            "ws://localhost:1/x",
            "ws://[::1]:8080/",
            "ws://127.0.0.1",
        ] {
            assert!(validate_ws_endpoint(ok).is_ok(), "{ok}");
        }
        for bad in [
            "ws://example.com/stream",
            "ws://10.0.0.5:80",
            "ws://localhost@evil.com/",
            "ws://127.0.0.1.evil.com/",
            "ftp://x",
            "not a url",
        ] {
            assert!(validate_ws_endpoint(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn endpoint_validation_flags_rest_https_url() {
        let e = validate_ws_endpoint("https://paper-api.alpaca.markets").unwrap_err();
        assert!(e.contains("https"), "{e}");
        assert!(e.contains("REST"), "{e}");
        assert!(validate_ws_endpoint("http://paper-api.alpaca.markets").is_err());
    }

    #[test]
    fn percent_encode_reserved_chars() {
        assert_eq!(percent_encode_component("a&b#c d"), "a%26b%23c%20d");
        assert_eq!(percent_encode_component("AZaz09-._~"), "AZaz09-._~");
        assert_eq!(percent_encode_component("é="), "%C3%A9%3D");
    }
}
