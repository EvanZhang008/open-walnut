//! The running connector: one iroh endpoint for this host, the member check on every incoming
//! daemon connection, the join protocol (join.rs), and local forwards (127.0.0.1 listeners) to
//! other members' daemons.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use iroh::endpoint::{BindOpts, Connection, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, Watcher};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, RwLock};

use crate::config::{Config, Member, RelayChoice, load_or_make_key};
use crate::join::{ALPN_JOIN, Joins};
use crate::log;

/// A stream to the peer's Walnut daemon (members only). The other protocol is ALPN_JOIN.
pub const ALPN_DAEMON: &[u8] = b"walnut/daemon/1";
/// Close code for a peer that is not a member allowed here (before any stream).
pub const CLOSE_NOT_MEMBER: u32 = 403;
/// Close code for a member that was removed while connected.
pub const CLOSE_REMOVED: u32 = 410;
const DIAL_TIMEOUT: Duration = Duration::from_secs(20);
/// The relay-first dial (see `Node::connection`); after it, the known addresses get DIAL_TIMEOUT.
const RELAY_DIAL_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Node {
    pub ep: Endpoint,
    pub choice: RelayChoice,
    relays: Vec<RelayUrl>,
    /// Pending invites and the join rate limits.
    pub joins: Joins,
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

/// Which iroh preset the endpoint starts from, and the relay mode set over it.
#[derive(Debug, PartialEq)]
pub struct Plan {
    /// presets::N0 (public relays, pkarr publishing and pkarr + DNS lookup), else presets::Minimal.
    pub n0: bool,
    /// None: the preset's own relays.
    pub relay: Option<RelayMode>,
}

pub fn plan(cfg: &Config) -> Result<Plan> {
    Ok(match cfg.relay_choice() {
        RelayChoice::Public => Plan { n0: true, relay: None },
        RelayChoice::Custom => {
            let relays = cfg.relay_urls()?;
            Plan { n0: false, relay: Some(if relays.is_empty() { RelayMode::Disabled } else { RelayMode::custom(relays) }) }
        }
        RelayChoice::None => Plan { n0: false, relay: Some(RelayMode::Disabled) },
    })
}

/// The file keeping the UDP port this host listened on last (next to its key).
pub fn port_file(cfg: &Config) -> PathBuf {
    PathBuf::from(format!("{}.port", cfg.key.display()))
}

fn remembered_port(file: &PathBuf) -> Option<u16> {
    std::fs::read_to_string(file).ok()?.trim().parse::<u16>().ok().filter(|p| *p >= 1024)
}

/// The endpoint on `port` (None: any free one).
async fn endpoint(cfg: &Config, port: Option<u16>) -> Result<Endpoint> {
    let key = load_or_make_key(&cfg.key)?;
    let plan = plan(cfg)?;
    // custom and none: Minimal is the crypto provider only, so no n0 address lookup or
    // publishing is added and only the user's relays (or none) are contacted. public: N0, whose
    // pkarr publisher keeps its default relay-only filter (no IP address is published).
    // Router port mapping (UPnP/PCP/NAT-PMP) is off in every mode.
    let mut b = if plan.n0 { Endpoint::builder(presets::N0) } else { Endpoint::builder(presets::Minimal) };
    if let Some(mode) = plan.relay {
        b = b.relay_mode(mode);
    }
    let mut b = b
        .portmapper_config(iroh::endpoint::PortmapperConfig::Disabled)
        .secret_key(key)
        .alpns(vec![ALPN_DAEMON.to_vec(), ALPN_JOIN.to_vec()]);
    let roots = cfg.root_certs()?;
    if !roots.is_empty() {
        b = b.ca_tls_config(iroh::tls::CaTlsConfig::embedded().with_extra_roots(roots));
    }
    if let Some(port) = port {
        b = b.bind_addr(SocketAddr::from(([0, 0, 0, 0], port)))?;
        // IPv6 on the same port when it is free; without it the endpoint still binds.
        b = b.bind_addr_with_opts(SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port)), BindOpts::default().set_is_required(false))?;
    }
    b.bind().await.context("bind the endpoint")
}

impl Node {
    pub async fn bind(cfg: &Config) -> Result<Arc<Self>> {
        let relays = cfg.relay_urls()?;
        // The port from last time, when the config names none: a machine that knows this host's
        // address finds it again after a restart (with no relay, nothing else would).
        let fixed = cfg.bind_port.filter(|p| *p != 0);
        let file = port_file(cfg);
        let last = if fixed.is_none() { remembered_port(&file) } else { None };
        let ep = match endpoint(cfg, fixed.or(last)).await {
            Err(e) if last.is_some() => {
                log::warn("the port from last time is taken; using another", json!({"port": last, "error": format!("{e:#}")}));
                endpoint(cfg, None).await?
            }
            r => r?,
        };
        let bound = ep.bound_sockets().iter().find(|a| a.is_ipv4()).map(|a| a.port());
        if fixed.is_none()
            && let Some(port) = bound
            && Some(port) != last
            && let Err(e) = std::fs::write(&file, format!("{port}\n"))
        {
            log::warn("could not keep the port", json!({"file": file.display().to_string(), "error": e.to_string()}));
        }
        Ok(Arc::new(Self {
            ep,
            choice: cfg.relay_choice(),
            relays,
            joins: Joins::default(),
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
                // Any peer may try a join, but only while an invite is pending (join.rs).
                if conn.alpn() == ALPN_JOIN {
                    crate::join::accept(&node.joins, conn).await;
                    return;
                }
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
                log::info("member connected", json!({"peer": peer.to_string(), "path": selected_kind(&conn), "conn": conn.stable_id()}));
                log_paths(conn.clone(), peer, "server");
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
                log::info("member disconnected", json!({"peer": peer.to_string(), "reason": conn.close_reason().map(|r| r.to_string()), "conn": conn.stable_id()}));
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
        // custom: through the user's relays; public: the lookup finds the relay by id; none: addrs only.
        let mut addr = EndpointAddr::new(peer);
        if self.choice == RelayChoice::Custom {
            for r in &self.relays {
                addr = addr.with_relay_url(r.clone());
            }
        }
        // Where it was last seen, in any mode with a relay: a machine that has not moved to
        // this host's relay choice yet (it was away) is still on the relay it had.
        if self.choice != RelayChoice::None {
            for r in &member.relays {
                if let Ok(u) = crate::config::parse_relay_url(r) {
                    addr = addr.with_relay_url(u);
                }
            }
        }
        // With a relay, the handshake goes through it first, with no direct address: the first
        // Initial to arrive pins the handshake to its path, so a direct path whose answers a
        // firewall drops (or that the peer answers from another address) stalls the whole dial.
        // Holepunching adds direct paths once connected, and only a path that answers both
        // ways is validated and used. The known addresses are the fallback when the relay does
        // not get through.
        if self.choice == RelayChoice::Public || (self.choice == RelayChoice::Custom && addr.relay_urls().next().is_some()) {
            match tokio::time::timeout(RELAY_DIAL_TIMEOUT, self.ep.connect(addr.clone(), ALPN_DAEMON)).await {
                Ok(Ok(conn)) => {
                    log::info("connected to member", json!({"peer": peer.to_string(), "name": member.name, "path": selected_kind(&conn), "conn": conn.stable_id(), "dial": "relay-first"}));
                    log_paths(conn.clone(), peer, "client");
                    self.outgoing.lock().await.insert(peer, conn.clone());
                    return Ok(conn);
                }
                Ok(Err(e)) => log::warn("dial through the relay failed; trying the known addresses", json!({"peer": peer.to_string(), "error": format!("{e:#}")})),
                Err(_) => log::warn("dial through the relay did not answer; trying the known addresses", json!({"peer": peer.to_string(), "secs": RELAY_DIAL_TIMEOUT.as_secs()})),
            }
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
        log::info("connected to member", json!({"peer": peer.to_string(), "name": member.name, "path": selected_kind(&conn), "conn": conn.stable_id()}));
        log_paths(conn.clone(), peer, "client");
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
            // The newest live one: while a link flaps, the oldest entry is often a connection
            // that is about to time out, and its paths say nothing about the current one.
            let conn = out.or_else(|| incoming.get(id).and_then(|v| v.iter().rev().find(|c| c.close_reason().is_none()).or(v.last())));
            if let Some(c) = conn {
                p["link"] = link_json(c);
            }
            peers.push(p);
        }
        let addr = self.ep.addr();
        json!({
            "id": self.ep.id().to_string(),
            "relayMode": self.choice.as_str(),
            "homeRelay": addr.relay_urls().next().map(|u| u.to_string()),
            "relays": relays,
            "addrs": addr.ip_addrs().map(|a| a.to_string()).collect::<Vec<_>>(),
            "peers": peers,
            "invites": self.joins.status(),
        })
    }
}

fn label(m: &Member, id: EndpointId) -> String {
    if m.name.is_empty() { id.fmt_short().to_string() } else { m.name.clone() }
}

pub fn selected_kind(conn: &Connection) -> &'static str {
    conn.paths().iter().find(|p| p.is_selected()).map(|p| if p.is_relay() { "relay" } else { "direct" }).unwrap_or("none")
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 10_000.0).round() / 10.0
}

/// Each path with both of its ends: the remote address and the local one it is sent from.
fn path_json(p: &iroh::endpoint::Path<'_>) -> Value {
    json!({
        "kind": if p.is_relay() { "relay" } else { "direct" },
        "addr": format!("{:?}", p.remote_addr()),
        "local": format!("{:?}", p.local_addr()),
        "selected": p.is_selected(),
        "rttMs": ms(p.rtt()),
    })
}

fn link_json(conn: &Connection) -> Value {
    let paths = conn.paths();
    let sel = paths.iter().find(|p| p.is_selected());
    json!({
        "path": selected_kind(conn),
        "rttMs": sel.map(|p| ms(p.rtt())),
        "side": if conn.side().is_client() { "client" } else { "server" },
        "conn": conn.stable_id(),
        "paths": paths.iter().map(|p| path_json(&p)).collect::<Vec<_>>(),
    })
}

/// One log line each time a connection's open paths or its selected path change, on both
/// sides: what is needed to see from the two machines' logs which path each end sends on.
fn log_paths(conn: Connection, peer: EndpointId, side: &'static str) {
    tokio::spawn(async move {
        use n0_future::StreamExt;
        let id = conn.stable_id();
        let mut stream = conn.paths_stream();
        let mut last = String::new();
        while let Some(list) = stream.next().await {
            let v: Vec<Value> = list.iter().map(|p| json!({
                "kind": if p.is_relay() { "relay" } else { "direct" },
                "addr": format!("{:?}", p.remote_addr()),
                "local": format!("{:?}", p.local_addr()),
                "selected": p.is_selected(),
            })).collect();
            let s = serde_json::to_string(&v).unwrap_or_default();
            if s != last {
                log::info("paths", json!({"peer": peer.to_string(), "side": side, "conn": id, "paths": v}));
                last = s;
            }
        }
    });
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(extra: Value) -> Config {
        let mut v = json!({"version": 1, "key": "k", "daemonPortFile": "p", "control": "c"});
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn each_relay_mode_picks_its_preset_and_relays() {
        let url: RelayUrl = "https://relay.example.test".parse().unwrap();
        let custom = Plan { n0: false, relay: Some(RelayMode::custom([url.clone()])) };
        assert_eq!(plan(&cfg(json!({"relays": [url.to_string()]}))).unwrap(), custom);
        assert_eq!(plan(&cfg(json!({"relayMode": "custom", "relays": [url.to_string()]}))).unwrap(), custom);
        let off = Plan { n0: false, relay: Some(RelayMode::Disabled) };
        assert_eq!(plan(&cfg(json!({}))).unwrap(), off);
        assert_eq!(plan(&cfg(json!({"relayMode": "none"}))).unwrap(), off);
        assert_eq!(plan(&cfg(json!({"relayMode": "custom"}))).unwrap(), off);
        // public keeps the N0 preset's own relays: nothing is set over them.
        assert_eq!(plan(&cfg(json!({"relayMode": "public"}))).unwrap(), Plan { n0: true, relay: None });
    }
}
