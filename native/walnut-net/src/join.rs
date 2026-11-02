//! Joining without a companion: a machine that has an invite code trades it, over ALPN
//! `walnut/join/1`, for a used invite on the host that made it. The host's daemon then sees the
//! used invite in `status` and adds the machine as a member; this protocol never makes one.
//!
//! The joiner opens one bi-stream and sends one line `{"code","hostname","platform","addrs"}`; the host
//! answers one line `{"ok":true,"name"}` or `{"ok":false,"error":"invalid_code"|"rate_limited"}`.
//! A join connection is closed before any stream unless an invite is pending.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use iroh::endpoint::{Connection, ConnectionError};
use iroh::{Endpoint, EndpointAddr, EndpointId, TransportAddr};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};

use crate::config::{RelayChoice, parse_relay_url};
pub use crate::invites::Joins;
use crate::invites::now_ms;
use crate::log;

pub const ALPN_JOIN: &[u8] = b"walnut/join/1";
/// Close code for a join while no invite is pending (before any stream).
pub const CLOSE_NO_INVITE: u32 = 403;
/// Close code for a join while too many others are being answered.
pub const CLOSE_BUSY: u32 = 429;
const STREAM_WAIT: Duration = Duration::from_secs(10);
const LINE_WAIT: Duration = Duration::from_secs(10);
const MAX_LINE: usize = 2048;
const MAX_REPLY: usize = 4096;
const DIAL_WAIT: Duration = Duration::from_secs(20);
/// How long the host waits for the joiner to close after the answer (closing first can drop it).
const LINGER: Duration = Duration::from_secs(5);

/// The host side of one join connection.
pub async fn accept(joins: &Joins, conn: Connection) {
    let peer = conn.remote_id();
    if !joins.pending(now_ms()) {
        // Debug only: any peer may knock, and the log must not grow with it.
        log::debug("join refused: no invite is open", json!({"peer": peer.to_string()}));
        conn.close(CLOSE_NO_INVITE.into(), b"no invite");
        return;
    }
    let Some(_slot) = joins.slot() else {
        log::debug("join refused: too many joins at once", json!({"peer": peer.to_string()}));
        conn.close(CLOSE_BUSY.into(), b"busy");
        return;
    };
    let talk = async {
        let (mut send, mut recv) = tokio::time::timeout(STREAM_WAIT, conn.accept_bi()).await.ok()?.ok()?;
        let line = tokio::time::timeout(LINE_WAIT, read_line(&mut recv, MAX_LINE)).await.ok()?.ok()?;
        // The direct paths it came in on: with no relay, the only way to find it again.
        let seen: Vec<SocketAddr> = conn.paths().iter().filter_map(|p| match p.remote_addr() { TransportAddr::Ip(a) => Some(*a), _ => None }).collect();
        let reply = joins.check_from(peer, line.as_deref(), &seen, now_ms(), Instant::now());
        send.write_all(format!("{reply}\n").as_bytes()).await.ok()?;
        send.finish().ok()?;
        Some(())
    };
    if talk.await.is_some() {
        let _ = tokio::time::timeout(LINGER, conn.closed()).await;
    }
    conn.close(0u32.into(), b"done");
}

/// The `join` control op, on the new machine: dial the host and trade the code.
pub async fn dial(ep: &Endpoint, choice: RelayChoice, to: EndpointId, req: &Value) -> Result<Value> {
    let text = |k: &str| req.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let code = req.get("code").and_then(Value::as_str).ok_or_else(|| anyhow!("`code` is required"))?;
    let mut addr = EndpointAddr::new(to);
    if let Some(list) = req.get("addrs").filter(|v| !v.is_null()) {
        for a in list.as_array().ok_or_else(|| anyhow!("`addrs` is not a list"))? {
            let s = a.as_str().unwrap_or("");
            addr = addr.with_ip_addr(s.parse::<SocketAddr>().with_context(|| format!("address {a} is not ip:port"))?);
        }
    }
    if let Some(r) = req.get("relay").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        addr = addr.with_relay_url(parse_relay_url(r)?);
    }
    if addr.is_empty() && choice != RelayChoice::Public {
        bail!("nothing to dial: give `addrs` or a `relay`");
    }
    // Where this machine listens, so a host with no relay can find it again.
    let own: Vec<String> = ep.addr().ip_addrs().take(8).map(|a| a.to_string()).collect();
    let line = json!({"code": code, "hostname": text("hostname"), "platform": text("platform"), "addrs": own});
    let attempt = async {
        let conn = ep.connect(addr, ALPN_JOIN).await.map_err(|e| anyhow!("connect: {e}"))?;
        let talk = async {
            let (mut send, mut recv) = conn.open_bi().await?;
            send.write_all(format!("{line}\n").as_bytes()).await?;
            send.finish()?;
            Ok::<_, anyhow::Error>(read_line(&mut recv, MAX_REPLY).await?)
        };
        let r = talk.await;
        // The host answered, by closing: it has no invite open (this one was used or ran out).
        let no_invite = matches!(conn.close_reason(), Some(ConnectionError::ApplicationClosed(c)) if c.error_code == CLOSE_NO_INVITE.into());
        conn.close(0u32.into(), b"done");
        if r.is_err() && no_invite {
            return Ok(Some(br#"{"ok":false,"error":"invalid_code"}"#.to_vec()));
        }
        r
    };
    let reply = match tokio::time::timeout(DIAL_WAIT, attempt).await {
        Err(_) => return Ok(no_answer(to, "timed out")),
        Ok(Err(e)) => return Ok(no_answer(to, &format!("{e:#}"))),
        Ok(Ok(None)) => bail!("the host's answer is too long"),
        Ok(Ok(Some(r))) if r.is_empty() => return Ok(no_answer(to, "the host closed the stream")),
        Ok(Ok(Some(r))) => r,
    };
    let v: Value = serde_json::from_slice(&reply).context("the host's answer is not JSON")?;
    match (v.get("ok").and_then(Value::as_bool), v.get("name").and_then(Value::as_str), v.get("error").and_then(Value::as_str)) {
        (Some(true), Some(name), _) => {
            log::info("joined", json!({"host": to.to_string(), "name": name}));
            Ok(json!({"ok": true, "name": name}))
        }
        (Some(false), _, Some(error)) => Ok(json!({"ok": false, "error": error})),
        _ => bail!("the host's answer is not a join answer"),
    }
}

fn no_answer(to: EndpointId, why: &str) -> Value {
    log::warn("join: no answer", json!({"host": to.to_string(), "error": why}));
    json!({"ok": false, "error": "no_answer"})
}

/// One line (without its newline), or None when it is longer than `max` bytes. A stream that
/// ends without a newline ends the line.
pub async fn read_line<R: AsyncRead + Unpin>(r: R, max: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut buf = vec![];
    BufReader::new(r.take(max as u64 + 1)).read_until(b'\n', &mut buf).await?;
    if buf.last() == Some(&b'\n') {
        buf.pop();
    } else if buf.len() > max {
        return Ok(None);
    }
    Ok(Some(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_line_stops_at_the_limit() {
        let ok = read_line(&b"{\"a\":1}\nmore"[..], 2048).await.unwrap();
        assert_eq!(ok.as_deref(), Some(&b"{\"a\":1}"[..]));
        let unended = read_line(&b"abc"[..], 2048).await.unwrap();
        assert_eq!(unended.as_deref(), Some(&b"abc"[..]));
        let exact = [vec![b'x'; 2048], vec![b'\n']].concat();
        assert_eq!(read_line(&exact[..], 2048).await.unwrap().map(|l| l.len()), Some(2048));
        let long = vec![b'x'; 5000];
        assert_eq!(read_line(&long[..], 2048).await.unwrap(), None);
    }
}
