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
}
