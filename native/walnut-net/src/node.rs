//! The running connector: one iroh endpoint for this host, the member check on every incoming
//! connection, and local forwards (127.0.0.1 listeners) to other members' daemons.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use iroh::endpoint::{Connection, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, Watcher};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, RwLock};

use crate::config::{Config, Member, load_or_make_key};
use crate::log;

/// The one protocol this endpoint speaks: a stream to the peer's Walnut daemon.
pub const ALPN_DAEMON: &[u8] = b"walnut/daemon/1";
/// Close code for a peer that is not a member allowed here (before any stream).
pub const CLOSE_NOT_MEMBER: u32 = 403;
/// Close code for a member that was removed while connected.
pub const CLOSE_REMOVED: u32 = 410;
const DIAL_TIMEOUT: Duration = Duration::from_secs(20);

pub struct Node {
    pub ep: Endpoint,
    relays: Vec<RelayUrl>,
    daemon_port_file: PathBuf,
    members: RwLock<HashMap<EndpointId, Member>>,
    /// Connections members opened to this host, so a removed member is cut at once.
    incoming: Mutex<HashMap<EndpointId, Vec<Connection>>>,
    /// The connection this host keeps to each member it dialled.
    outgoing: Mutex<HashMap<EndpointId, Connection>>,
    /// One dial at a time per peer.
    dialing: Mutex<HashMap<EndpointId, Arc<Mutex<()>>>>,
    /// Local forwards: peer -> (port, accept task).
    forwards: Mutex<HashMap<EndpointId, (u16, tokio::task::JoinHandle<()>)>>,
}

impl Node {
    pub async fn bind(cfg: &Config) -> Result<Arc<Self>> {
        let key = load_or_make_key(&cfg.key)?;
        let relays = cfg.relay_urls()?;
        let mode = if relays.is_empty() { RelayMode::Disabled } else { RelayMode::custom(relays.clone()) };
        // Minimal = the crypto provider only: no n0 DNS/pkarr address lookup or publishing is added.
        // Router port mapping (UPnP/PCP/NAT-PMP) is off too: nothing outside the user's machines and
        // relays is ever contacted.
        let mut b = Endpoint::builder(presets::Minimal)
            .relay_mode(mode)
            .portmapper_config(iroh::endpoint::PortmapperConfig::Disabled)
            .secret_key(key)
            .alpns(vec![ALPN_DAEMON.to_vec()]);
        let roots = cfg.root_certs()?;
        if !roots.is_empty() {
            b = b.ca_tls_config(iroh::tls::CaTlsConfig::embedded().with_extra_roots(roots));
        }
        if let Some(port) = cfg.bind_port.filter(|p| *p != 0) {
            b = b.bind_addr(SocketAddr::from(([0, 0, 0, 0], port)))?;
        }
        let ep = b.bind().await.context("bind the endpoint")?;
        Ok(Arc::new(Self {
            ep,
            relays,
            daemon_port_file: cfg.daemon_port_file.clone(),
            members: RwLock::new(cfg.member_map()),
            incoming: Mutex::new(HashMap::new()),
            outgoing: Mutex::new(HashMap::new()),
            dialing: Mutex::new(HashMap::new()),
            forwards: Mutex::new(HashMap::new()),
        }))
    }

    /// New members: the ones no longer allowed in are cut, forwards to non-members stop.
    pub async fn set_members(&self, cfg: &Config) -> Result<()> {
        let next = cfg.member_map();
        *self.members.write().await = next.clone();
        let mut incoming = self.incoming.lock().await;
        incoming.retain(|id, conns| {
            let keep = next.get(id).is_some_and(|m| m.accept);
            if !keep {
                for c in conns.iter() {
                    c.close(CLOSE_REMOVED.into(), b"no longer a member");
                }
                log::info("member removed: incoming connections closed", json!({"peer": id.to_string()}));
            }
            keep
        });
        drop(incoming);
        self.outgoing.lock().await.retain(|id, c| {
            let keep = next.contains_key(id);
            if !keep {
                c.close(CLOSE_REMOVED.into(), b"no longer a member");
            }
            keep
        });
        self.forwards.lock().await.retain(|id, (_, task)| {
            let keep = next.contains_key(id);
            if !keep {
                task.abort();
            }
            keep
        });
        Ok(())
    }

    /// Accept loop: the member check runs on the peer's id, which the TLS handshake proved is
    /// its key, before the peer can open any stream.
    pub async fn serve(self: Arc<Self>) {
        while let Some(incoming) = self.ep.accept().await {
            let node = self.clone();
            tokio::spawn(async move {
                let conn = match incoming.await {
                    Ok(c) => c,
                    Err(e) => {
                        log::debug("incoming handshake failed", json!({"error": e.to_string()}));
                        return;
                    }
                };
                let peer = conn.remote_id();
                // The check and the record happen under the incoming lock, which set_members takes
                // after it swaps the list: a removal either is seen here, or finds this connection
                // recorded and closes it.
                {
                    let mut incoming = node.incoming.lock().await;
                    let allowed = node.members.read().await.get(&peer).is_some_and(|m| m.accept);
                    if !allowed {
                        drop(incoming);
                        log::warn("refused a connection from an endpoint that is not a member allowed here", json!({"peer": peer.to_string()}));
                        conn.close(CLOSE_NOT_MEMBER.into(), b"not a member");
                        return;
                    }
                    incoming.entry(peer).or_default().push(conn.clone());
                }
                log::info("member connected", json!({"peer": peer.to_string(), "path": selected_kind(&conn)}));
                while let Ok((send, recv)) = conn.accept_bi().await {
                    let port_file = node.daemon_port_file.clone();
                    tokio::spawn(async move {
                        match daemon_port(&port_file).await {
                            Ok(port) => match TcpStream::connect(("127.0.0.1", port)).await {
                                Ok(tcp) => pipe(tcp, send, recv).await,
                                Err(e) => log::warn("daemon not reachable", json!({"port": port, "error": e.to_string()})),
                            },
                            Err(e) => log::warn("daemon port unknown", json!({"error": e.to_string()})),
                        }
                    });
                }
                let mut incoming = node.incoming.lock().await;
                if let Some(list) = incoming.get_mut(&peer) {
                    list.retain(|c| c.stable_id() != conn.stable_id());
                    if list.is_empty() {
                        incoming.remove(&peer);
                    }
                }
                log::info("member disconnected", json!({"peer": peer.to_string(), "reason": conn.close_reason().map(|r| r.to_string())}));
            });
        }
    }

    /// The live connection to a member, dialled when there is none.
    pub async fn connection(&self, peer: EndpointId) -> Result<Connection> {
        let gate = self.dialing.lock().await.entry(peer).or_default().clone();
        let _one = gate.lock().await;
        if let Some(c) = self.outgoing.lock().await.get(&peer) {
            if c.close_reason().is_none() {
                return Ok(c.clone());
            }
        }
        let member = self.members.read().await.get(&peer).cloned().ok_or_else(|| anyhow!("{peer} is not a member"))?;
        let mut addr = EndpointAddr::new(peer);
        for r in &self.relays {
            addr = addr.with_relay_url(r.clone());
        }
        for a in &member.addrs {
            if let Ok(sa) = a.parse::<SocketAddr>() {
                addr = addr.with_ip_addr(sa);
            }
        }
        let conn = tokio::time::timeout(DIAL_TIMEOUT, self.ep.connect(addr, ALPN_DAEMON))
            .await
            .map_err(|_| anyhow!("{} did not answer in {}s", label(&member, peer), DIAL_TIMEOUT.as_secs()))?
            .with_context(|| format!("connect to {}", label(&member, peer)))?;
        log::info("connected to member", json!({"peer": peer.to_string(), "name": member.name, "path": selected_kind(&conn)}));
        self.outgoing.lock().await.insert(peer, conn.clone());
        Ok(conn)
    }

    /// A 127.0.0.1 port whose every connection is a stream to that member's daemon. One per member.
    pub async fn forward(self: &Arc<Self>, peer: EndpointId) -> Result<u16> {
        if !self.members.read().await.contains_key(&peer) {
            return Err(anyhow!("{peer} is not a member"));
        }
        let mut forwards = self.forwards.lock().await;
        if let Some((port, task)) = forwards.get(&peer) {
            if !task.is_finished() {
                return Ok(*port);
            }
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let node = self.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else { break };
                let node = node.clone();
                tokio::spawn(async move {
                    let opened = async {
                        let conn = node.connection(peer).await?;
                        match conn.open_bi().await {
                            Ok(s) => Ok(s),
                            Err(_) => {
                                // A connection that died since it was cached: dial once more.
                                node.outgoing.lock().await.remove(&peer);
                                Ok::<_, anyhow::Error>(node.connection(peer).await?.open_bi().await?)
                            }
                        }
                    };
                    match opened.await {
                        Ok((send, recv)) => pipe(tcp, send, recv).await,
                        Err(e) => log::warn("forward: no stream to the member", json!({"peer": peer.to_string(), "error": format!("{e:#}")})),
                    }
                });
            }
        });
        forwards.insert(peer, (port, task));
        log::info("forward opened", json!({"peer": peer.to_string(), "port": port}));
        Ok(port)
    }

    /// Dial (if needed) and say how the link to a member goes.
    pub async fn probe(&self, peer: EndpointId) -> Result<Value> {
        let conn = self.connection(peer).await?;
        // Give hole punching a moment when the link is only on the relay.
        if selected_kind(&conn) != "direct" {
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
        Ok(link_json(&conn))
    }

    pub async fn status(&self) -> Value {
        let relays: Vec<Value> = self
            .ep
            .home_relay_status()
            .get()
            .iter()
            .map(|r| json!({"url": r.url().to_string(), "connected": r.is_connected(), "error": r.last_error().map(|e| e.to_string())}))
            .collect();
        let members = self.members.read().await.clone();
        let incoming = self.incoming.lock().await;
        let outgoing = self.outgoing.lock().await;
        let forwards = self.forwards.lock().await;
        let mut peers = vec![];
        for (id, m) in &members {
            let out = outgoing.get(id).filter(|c| c.close_reason().is_none());
            let inc = incoming.get(id).map(|v| v.len()).unwrap_or(0);
            let mut p = json!({
                "id": id.to_string(), "name": m.name, "accept": m.accept, "incoming": inc,
                "forwardPort": forwards.get(id).filter(|(_, t)| !t.is_finished()).map(|(p, _)| *p),
            });
            let conn = out.or_else(|| incoming.get(id).and_then(|v| v.first()));
            if let Some(c) = conn {
                p["link"] = link_json(c);
            }
            peers.push(p);
        }
        let addr = self.ep.addr();
        json!({
            "id": self.ep.id().to_string(),
            "relays": relays,
            "addrs": addr.ip_addrs().map(|a| a.to_string()).collect::<Vec<_>>(),
            "peers": peers,
        })
    }
}

fn label(m: &Member, id: EndpointId) -> String {
    if m.name.is_empty() { id.fmt_short().to_string() } else { m.name.clone() }
}

pub fn selected_kind(conn: &Connection) -> &'static str {
    conn.paths().iter().find(|p| p.is_selected()).map(|p| if p.is_relay() { "relay" } else { "direct" }).unwrap_or("none")
}

fn link_json(conn: &Connection) -> Value {
    let paths = conn.paths();
    let sel = paths.iter().find(|p| p.is_selected());
    json!({
        "path": selected_kind(conn),
        "rttMs": sel.map(|p| (p.rtt().as_secs_f64() * 10_000.0).round() / 10.0),
        "paths": paths.iter().map(|p| json!({
            "kind": if p.is_relay() { "relay" } else { "direct" },
            "addr": format!("{:?}", p.remote_addr()),
            "selected": p.is_selected(),
        })).collect::<Vec<_>>(),
    })
}

async fn daemon_port(file: &PathBuf) -> Result<u16> {
    let s = tokio::fs::read_to_string(file).await.with_context(|| format!("read {}", file.display()))?;
    let port: u16 = s.trim().parse().with_context(|| format!("{}: not a port", file.display()))?;
    if port == 0 {
        return Err(anyhow!("{}: port 0", file.display()));
    }
    Ok(port)
}

/// Bytes both ways until each side ends; an end on one side finishes the other.
pub async fn pipe(tcp: TcpStream, mut send: iroh::endpoint::SendStream, mut recv: iroh::endpoint::RecvStream) {
    let _ = tcp.set_nodelay(true);
    let (mut tr, mut tw) = tcp.into_split();
    let up = async {
        let _ = tokio::io::copy(&mut tr, &mut send).await;
        let _ = send.finish();
    };
    let down = async {
        let _ = tokio::io::copy(&mut recv, &mut tw).await;
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut tw).await;
    };
    tokio::join!(up, down);
}
