//! Walnut Connect: the user's paired phones reach this host's Walnut server.
//!
//! A phone (the Walnut app, native/walnut-connect) dials this endpoint on ALPN walnut/web/1.
//! The connection is closed before any stream unless the phone's id (its key, proven by the
//! TLS handshake) is listed in `phones`. Each stream it opens is piped to the server's connect
//! door, a unix socket the server listens on (`webSocket`), which never counts a caller as this
//! machine: every request still needs the phone's device token. A phone is never a member, so
//! it can never open a stream to the daemon (node.rs), and a member is never a phone.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use iroh::EndpointId;
use iroh::endpoint::Connection;
use serde_json::{Value, json};
use tokio::net::UnixStream;
use tokio::sync::{Mutex, RwLock, Semaphore};

use crate::config::{Config, Phone};
use crate::log;
use crate::node::{CLOSE_NOT_MEMBER, CLOSE_REMOVED, link_json, pipe_io, selected_kind};

/// The protocol a phone speaks: plain HTTP/1.1 (and WebSocket upgrades) over each stream.
pub const ALPN_WEB: &[u8] = b"walnut/web/1";
/// Connections one phone may hold at once; the oldest is closed for a new one (an app that
/// came back from the background dials again while iOS has not told it the old one is gone).
const MAX_CONNS_PER_PHONE: usize = 4;
/// Streams one connection may have open at once (each is one HTTP connection of the app's).
const MAX_STREAMS_PER_CONN: usize = 64;
/// The close of a connection a newer one of the same phone replaced (not a refusal: the
/// phone's connector tells 403 and 410 apart from it, native/walnut-connect/src/client.rs).
pub const CLOSE_REPLACED: u32 = 409;
/// A refused stranger is logged at most this often (anyone who knows this host's id can try).
const REFUSED_LOG_EVERY_MS: u64 = 10_000;

static REFUSED_LOGGED_AT: AtomicU64 = AtomicU64::new(0);
static REFUSED_SINCE_LOG: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Log a refused phone, at most once per REFUSED_LOG_EVERY_MS, with how many were not logged.
fn log_refused(peer: &EndpointId, door: bool) {
    let now = now_ms();
    let last = REFUSED_LOGGED_AT.load(Ordering::Relaxed);
    if now.saturating_sub(last) < REFUSED_LOG_EVERY_MS
        || REFUSED_LOGGED_AT.compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed).is_err()
    {
        REFUSED_SINCE_LOG.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let skipped = REFUSED_SINCE_LOG.swap(0, Ordering::Relaxed);
    log::warn("refused a phone that is not paired here", json!({"peer": peer.to_string(), "door": door, "notLogged": skipped}));
}

#[derive(Default)]
pub struct Web {
    phones: RwLock<HashMap<EndpointId, Phone>>,
    socket: RwLock<Option<PathBuf>>,
    conns: Mutex<HashMap<EndpointId, Vec<Connection>>>,
}

impl Web {
    pub fn new(cfg: &Config) -> Self {
        Self { phones: RwLock::new(cfg.phone_map()), socket: RwLock::new(cfg.web_socket.clone()), conns: Mutex::default() }
    }

    /// New phones and door: a phone no longer listed is cut at once.
    pub async fn set(&self, cfg: &Config) {
        let next = cfg.phone_map();
        *self.phones.write().await = next.clone();
        *self.socket.write().await = cfg.web_socket.clone();
        let mut conns = self.conns.lock().await;
        conns.retain(|id, list| {
            let keep = next.contains_key(id) && cfg.web_socket.is_some();
            if !keep {
                for c in list.iter() {
                    c.close(CLOSE_REMOVED.into(), b"no longer paired");
                }
                log::info("phone removed: its connections closed", json!({"phone": id.to_string()}));
            }
            keep
        });
    }

    /// Serve one incoming walnut/web/1 connection until it ends.
    pub async fn accept(self: &Arc<Self>, conn: Connection) {
        let peer = conn.remote_id();
        {
            // The check and the record under one lock, which set() takes after it swaps the
            // list: a removal either is seen here or finds this connection and closes it.
            let mut conns = self.conns.lock().await;
            let listed = self.phones.read().await.get(&peer).cloned();
            let door = self.socket.read().await.is_some();
            let Some(phone) = listed.filter(|_| door) else {
                drop(conns);
                log_refused(&peer, door);
                conn.close(CLOSE_NOT_MEMBER.into(), b"not paired");
                return;
            };
            let list = conns.entry(peer).or_default();
            list.retain(|c| c.close_reason().is_none());
            while list.len() >= MAX_CONNS_PER_PHONE {
                let old = list.remove(0);
                old.close(CLOSE_REPLACED.into(), b"replaced by a newer connection");
            }
            list.push(conn.clone());
            log::info("phone connected", json!({"phone": peer.to_string(), "name": phone.name, "path": selected_kind(&conn), "conn": conn.stable_id()}));
        }
        let streams = Arc::new(Semaphore::new(MAX_STREAMS_PER_CONN));
        while let Ok((mut send, recv)) = conn.accept_bi().await {
            let Ok(permit) = streams.clone().try_acquire_owned() else {
                // Over the cap: this stream is refused, the connection and its other streams go on.
                let _ = send.reset(429u32.into());
                continue;
            };
            let web = self.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let Some(socket) = web.socket.read().await.clone() else {
                    let _ = send.reset(503u32.into());
                    return;
                };
                match UnixStream::connect(&socket).await {
                    Ok(door) => pipe_io(door, send, recv).await,
                    Err(e) => {
                        log::warn("the Walnut server's connect door is not reachable", json!({"socket": socket.display().to_string(), "error": e.to_string()}));
                        let _ = send.reset(503u32.into());
                    }
                }
            });
        }
        let mut conns = self.conns.lock().await;
        if let Some(list) = conns.get_mut(&peer) {
            list.retain(|c| c.stable_id() != conn.stable_id());
            if list.is_empty() {
                conns.remove(&peer);
            }
        }
        log::info("phone disconnected", json!({"phone": peer.to_string(), "reason": conn.close_reason().map(|r| r.to_string()), "conn": conn.stable_id()}));
    }

    /// Each listed phone, with its newest live connection's link.
    pub async fn status(&self) -> Value {
        let phones = self.phones.read().await.clone();
        let conns = self.conns.lock().await;
        let list: Vec<Value> = phones
            .iter()
            .map(|(id, p)| {
                let live: Vec<&Connection> = conns.get(id).map(|v| v.iter().filter(|c| c.close_reason().is_none()).collect()).unwrap_or_default();
                let mut v = json!({"id": id.to_string(), "name": p.name, "connections": live.len()});
                if let Some(c) = live.last() {
                    v["link"] = link_json(c);
                }
                v
            })
            .collect();
        json!({"door": self.socket.read().await.as_ref().map(|p| p.display().to_string()), "phones": list})
    }
}
