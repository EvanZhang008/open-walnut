//! The control socket: a unix socket in a 0700 directory, mode 0600, one JSON request line per
//! connection and one JSON answer line. Only this account (the daemon, the Walnut server) reaches it.
//!
//!   {"op":"status"}                    -> {"ok":true, "id", "relays", "addrs", "peers"}
//!   {"op":"forward","to":"<id>"}       -> {"ok":true, "port"}   (127.0.0.1; each connection = a stream to that member's daemon)
//!   {"op":"probe","to":"<id>"}         -> {"ok":true, "link": {"path": "direct"|"relay", "rttMs", ...}}
//!   {"op":"reload"}                    -> {"ok":true, "restart": bool}  (re-read the config; restart: the endpoint must be rebuilt)

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use iroh::EndpointId;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::mpsc;

use crate::log;
use crate::node::Node;

const MAX_REQUEST: u64 = 64 * 1024;

pub enum Event {
    Reload(tokio::sync::oneshot::Sender<Result<bool>>),
}

/// Bind the socket. Refuses when another connector already answers on it (one per daemon).
pub async fn bind(path: &Path) -> Result<UnixListener> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    if path.exists() {
        if tokio::net::UnixStream::connect(path).await.is_ok() {
            bail!("another walnut-net already runs on {}", path.display());
        }
        std::fs::remove_file(path)?;
    }
    let l = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(l)
}

pub async fn serve(listener: UnixListener, node: Arc<Node>, events: mpsc::Sender<Event>) {
    loop {
        let sock = match listener.accept().await {
            Ok((sock, _)) => sock,
            Err(e) => {
                // Out of file descriptors and the like: wait instead of spinning on it.
                log::warn("control socket accept failed", json!({"error": e.to_string()}));
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                continue;
            }
        };
        let node = node.clone();
        let events = events.clone();
        tokio::spawn(async move {
            let (r, mut w) = sock.into_split();
            let mut line = String::new();
            let mut reader = BufReader::new(tokio::io::AsyncReadExt::take(r, MAX_REQUEST));
            if reader.read_line(&mut line).await.is_err() {
                return;
            }
            let answer = match handle(&line, &node, &events).await {
                Ok(v) => v,
                Err(e) => json!({"ok": false, "error": format!("{e:#}")}),
            };
            let _ = w.write_all(format!("{answer}\n").as_bytes()).await;
            let _ = w.shutdown().await;
        });
    }
}

fn peer_of(req: &Value) -> Result<EndpointId> {
    let to = req.get("to").and_then(Value::as_str).ok_or_else(|| anyhow!("`to` (an endpoint id) is required"))?;
    to.parse().map_err(|e| anyhow!("bad endpoint id {to}: {e}"))
}

async fn handle(line: &str, node: &Arc<Node>, events: &mpsc::Sender<Event>) -> Result<Value> {
    let req: Value = serde_json::from_str(line.trim()).map_err(|e| anyhow!("not a JSON request: {e}"))?;
    match req.get("op").and_then(Value::as_str).unwrap_or("") {
        "status" => {
            let mut s = node.status().await;
            s["ok"] = json!(true);
            Ok(s)
        }
        "forward" => {
            let port = node.forward(peer_of(&req)?).await?;
            Ok(json!({"ok": true, "port": port}))
        }
        "probe" => {
            let link = node.probe(peer_of(&req)?).await?;
            Ok(json!({"ok": true, "link": link}))
        }
        "reload" => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            events.send(Event::Reload(tx)).await.map_err(|_| anyhow!("shutting down"))?;
            let restart = rx.await.map_err(|_| anyhow!("shutting down"))??;
            log::info("config reloaded", json!({"restart": restart}));
            Ok(json!({"ok": true, "restart": restart}))
        }
        other => bail!("unknown op {other:?}"),
    }
}
