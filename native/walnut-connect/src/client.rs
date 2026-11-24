//! The connector: one iroh endpoint with the phone's key, one connection to its Walnut (the
//! Mac's walnut-net, ALPN walnut/web/1), and a 127.0.0.1 port whose every TCP connection is a
//! stream on it. The app's HTTP client talks to the port as it would to the Mac on the LAN.
//!
//! The Mac checks this endpoint's id against its paired phones before any stream, and every
//! request through it still needs the device token, so the port gives nothing to another app
//! on the phone that connects to it (it reaches only what an unpaired caller of the Mac's
//! server reaches: who the box is).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use iroh::endpoint::{Connection, PortmapperConfig, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey, Watcher};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

/// The protocol the Mac's walnut-net takes phones on (native/walnut-net/src/web.rs).
pub const ALPN_WEB: &[u8] = b"walnut/web/1";
/// The relay-first dial; after it, the known addresses get DIAL_TIMEOUT.
const RELAY_DIAL_TIMEOUT: Duration = Duration::from_secs(8);
const DIAL_TIMEOUT: Duration = Duration::from_secs(12);
/// Connections waiting for a stream at once; more are closed (a runaway client, never the app).
const MAX_PENDING: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelayChoice {
    /// The relays listed (the user's own, on their cloud companion).
    Custom,
    /// iroh's public relays and address lookup.
    Public,
    /// Direct paths only.
    None,
}

/// The Walnut this phone reaches: its network id, and where it was last seen.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    #[serde(default)]
    pub relays: Vec<String>,
    #[serde(default)]
    pub addrs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The phone's secret key: 64 hex characters (32 bytes).
    pub key: String,
    pub peer: Peer,
    /// Absent: `public`, as the Mac's own network runs with no companion.
    #[serde(default)]
    pub relay_mode: Option<RelayChoice>,
    /// With `custom`: the relays (https URLs).
    #[serde(default)]
    pub relays: Vec<String>,
    /// Extra trust roots (PEM) for a custom relay's address discovery.
    #[serde(default)]
    pub relay_roots: Vec<String>,
    /// The local port to listen on when it is free (the app keeps the one it had, so the
    /// address it stored still works); 0 or absent: any.
    #[serde(default)]
    pub port: Option<u16>,
}

impl Config {
    pub fn parse(text: &str) -> Result<Self> {
        let c: Config = serde_json::from_str(text).context("Walnut Connect config")?;
        secret_key(&c.key)?;
        c.peer_id()?;
        for a in &c.peer.addrs {
            a.parse::<SocketAddr>().with_context(|| format!("peer address {a}"))?;
        }
        for r in c.peer.relays.iter().chain(&c.relays) {
            relay_url(r)?;
        }
        if c.choice() != RelayChoice::Custom && !c.relays.is_empty() {
            bail!("relays are only for relayMode custom");
        }
        Ok(c)
    }

    pub fn choice(&self) -> RelayChoice {
        self.relay_mode.unwrap_or(RelayChoice::Public)
    }

    /// What needs a new endpoint when it changes; where the peer was seen does not.
    pub fn same_endpoint(&self, other: &Config) -> bool {
        self.key.eq_ignore_ascii_case(&other.key)
            && self.peer.id.eq_ignore_ascii_case(&other.peer.id)
            && self.choice() == other.choice()
            && self.relays == other.relays
            && self.relay_roots == other.relay_roots
    }

    pub fn peer_id(&self) -> Result<EndpointId> {
        self.peer.id.parse().map_err(|e| anyhow!("peer id {}: {e}", self.peer.id))
    }
}

pub fn secret_key(hex: &str) -> Result<SecretKey> {
    let hex = hex.trim();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("the key is not 64 hex characters");
    }
    let mut b = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        b[i] = u8::from_str_radix(std::str::from_utf8(chunk)?, 16)?;
    }
    Ok(SecretKey::from_bytes(&b))
}

/// The endpoint id (hex) of a secret key: what the Mac lists for this phone.
pub fn endpoint_id(hex: &str) -> Result<String> {
    Ok(secret_key(hex)?.public().to_string())
}

fn relay_url(u: &str) -> Result<RelayUrl> {
    let url: RelayUrl = u.parse().with_context(|| format!("relay URL {u}"))?;
    if url.scheme() != "https" && std::env::var_os("WALNUT_NET_ALLOW_HTTP_RELAY").is_none() {
        bail!("relay {u} is not https");
    }
    Ok(url)
}

pub struct Client {
    pub ep: Endpoint,
    /// The config it started on, with the latest hints of where the peer is.
    cfg: std::sync::Mutex<Config>,
    peer: EndpointId,
    pub port: u16,
    conn: Mutex<Option<Connection>>,
    /// One dial at a time.
    dialing: Mutex<()>,
    accept: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    last_error: std::sync::Mutex<Option<(String, Instant)>>,
    started: Instant,
    streams: std::sync::atomic::AtomicU64,
}

impl Client {
    pub async fn start(cfg: Config) -> Result<Arc<Self>> {
        let key = secret_key(&cfg.key)?;
        let peer = cfg.peer_id()?;
        let mut b = match cfg.choice() {
            RelayChoice::Public => Endpoint::builder(presets::N0),
            RelayChoice::Custom => {
                let relays = cfg.relays.iter().map(|r| relay_url(r)).collect::<Result<Vec<_>>>()?;
                Endpoint::builder(presets::Minimal).relay_mode(if relays.is_empty() { RelayMode::Disabled } else { RelayMode::custom(relays) })
            }
            RelayChoice::None => Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled),
        };
        b = b.portmapper_config(PortmapperConfig::Disabled).secret_key(key).alpns(vec![]);
        if !cfg.relay_roots.is_empty() {
            use rustls::pki_types::{CertificateDer, pem::PemObject};
            let mut roots = vec![];
            for pem in &cfg.relay_roots {
                for c in CertificateDer::pem_slice_iter(pem.as_bytes()) {
                    roots.push(c.context("relay root certificate")?);
                }
            }
            b = b.ca_tls_config(iroh::tls::CaTlsConfig::embedded().with_extra_roots(roots));
        }
        let ep = b.bind().await.context("bind the endpoint")?;
        let listener = match cfg.port.filter(|p| *p != 0) {
            Some(p) => match TcpListener::bind(("127.0.0.1", p)).await {
                Ok(l) => l,
                Err(_) => TcpListener::bind(("127.0.0.1", 0)).await?,
            },
            None => TcpListener::bind(("127.0.0.1", 0)).await?,
        };
        let port = listener.local_addr()?.port();
        let client = Arc::new(Self {
            ep,
            cfg: std::sync::Mutex::new(cfg),
            peer,
            port,
            conn: Mutex::new(None),
            dialing: Mutex::new(()),
            accept: std::sync::Mutex::new(None),
            last_error: std::sync::Mutex::new(None),
            started: Instant::now(),
            streams: Default::default(),
        });
        let c = client.clone();
        let task = tokio::spawn(async move { c.serve(listener).await });
        *client.accept.lock().unwrap() = Some(task);
        Ok(client)
    }

    async fn serve(self: Arc<Self>, listener: TcpListener) {
        let pending = Arc::new(tokio::sync::Semaphore::new(MAX_PENDING));
        loop {
            let tcp = match listener.accept().await {
                Ok((tcp, from)) if from.ip().is_loopback() => tcp,
                Ok(_) => continue,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
            };
            let Ok(permit) = pending.clone().try_acquire_owned() else { continue };
            let c = self.clone();
            tokio::spawn(async move {
                let opened = async {
                    let conn = c.connection().await?;
                    match conn.open_bi().await {
                        Ok(s) => Ok(s),
                        Err(_) => {
                            // A connection that died since it was cached: dial once more.
                            c.forget(&conn).await;
                            Ok::<_, anyhow::Error>(c.connection().await?.open_bi().await?)
                        }
                    }
                };
                match opened.await {
                    Ok((send, recv)) => {
                        drop(permit);
                        c.streams.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        pipe(tcp, send, recv).await
                    }
                    Err(e) => c.note_error(format!("{e:#}")),
                }
            });
        }
    }

    /// A start with this config can keep the running client: the same endpoint. The peer's
    /// relays and addresses are taken as the latest hints for the next dial.
    pub fn same_config(&self, next: &Config) -> bool {
        let mut cfg = self.cfg.lock().unwrap();
        if !cfg.same_endpoint(next) {
            return false;
        }
        cfg.peer.relays = next.peer.relays.clone();
        cfg.peer.addrs = next.peer.addrs.clone();
        true
    }

    fn config(&self) -> Config {
        self.cfg.lock().unwrap().clone()
    }

    fn note_error(&self, e: String) {
        *self.last_error.lock().unwrap() = Some((e, Instant::now()));
    }

    async fn forget(&self, dead: &Connection) {
        let mut cur = self.conn.lock().await;
        if cur.as_ref().is_some_and(|c| c.stable_id() == dead.stable_id()) {
            *cur = None;
        }
    }

    /// The live connection to the Walnut, dialled when there is none.
    pub async fn connection(&self) -> Result<Connection> {
        if let Some(c) = self.conn.lock().await.as_ref().filter(|c| c.close_reason().is_none()) {
            return Ok(c.clone());
        }
        let _one = self.dialing.lock().await;
        if let Some(c) = self.conn.lock().await.as_ref().filter(|c| c.close_reason().is_none()) {
            return Ok(c.clone());
        }
        let cfg = self.config();
        let mut addr = EndpointAddr::new(self.peer);
        let choice = cfg.choice();
        if choice != RelayChoice::None {
            for r in cfg.peer.relays.iter().chain(&cfg.relays) {
                if let Ok(u) = relay_url(r) {
                    addr = addr.with_relay_url(u);
                }
            }
        }
        // Through the relay first (the lookup finds it by id on public relays): the first
        // Initial to arrive pins the handshake to its path, so a direct address whose answers
        // a firewall drops would stall the dial. Holepunching adds the direct path after.
        let mut first_error = None;
        if choice == RelayChoice::Public || addr.relay_urls().next().is_some() {
            match tokio::time::timeout(RELAY_DIAL_TIMEOUT, self.ep.connect(addr.clone(), ALPN_WEB)).await {
                Ok(Ok(conn)) => return Ok(self.keep(conn).await),
                Ok(Err(e)) => first_error = Some(format!("{e:#}")),
                Err(_) => first_error = Some(format!("the relay did not get through in {}s", RELAY_DIAL_TIMEOUT.as_secs())),
            }
        }
        let mut direct = false;
        for a in &cfg.peer.addrs {
            if let Ok(sa) = a.parse::<SocketAddr>() {
                addr = addr.with_ip_addr(sa);
                direct = true;
            }
        }
        if !direct {
            if let Some(e) = first_error {
                bail!("could not reach your Walnut: {e}");
            }
            bail!("could not reach your Walnut: no relay and no address to dial");
        }
        let conn = tokio::time::timeout(DIAL_TIMEOUT, self.ep.connect(addr, ALPN_WEB))
            .await
            .map_err(|_| anyhow!("your Walnut did not answer in {}s", DIAL_TIMEOUT.as_secs()))?
            .context("could not reach your Walnut")?;
        Ok(self.keep(conn).await)
    }

    async fn keep(&self, conn: Connection) -> Connection {
        *self.conn.lock().await = Some(conn.clone());
        conn
    }

    /// The network under the app changed (Wi-Fi to cellular, back from the background).
    pub async fn network_changed(&self) {
        self.ep.network_change().await;
    }

    pub async fn status(&self) -> Value {
        let conn = self.conn.lock().await.clone().filter(|c| c.close_reason().is_none());
        let link = conn.as_ref().map(|c| {
            let paths = c.paths();
            let sel = paths.iter().find(|p| p.is_selected());
            json!({
                "path": sel.as_ref().map(|p| if p.is_relay() { "relay" } else { "direct" }).unwrap_or("none"),
                "rttMs": sel.as_ref().map(|p| (p.rtt().as_secs_f64() * 10_000.0).round() / 10.0),
            })
        });
        let relays: Vec<Value> = self
            .ep
            .home_relay_status()
            .get()
            .iter()
            .map(|r| json!({"url": r.url().to_string(), "connected": r.is_connected()}))
            .collect();
        let err = self.last_error.lock().unwrap().clone().map(|(e, at)| json!({"error": e, "agoMs": at.elapsed().as_millis() as u64}));
        json!({
            "running": true,
            "id": self.ep.id().to_string(),
            "peer": self.peer.to_string(),
            "port": self.port,
            "relayMode": match self.config().choice() { RelayChoice::Public => "public", RelayChoice::Custom => "custom", RelayChoice::None => "none" },
            "relays": relays,
            "link": link,
            "streams": self.streams.load(std::sync::atomic::Ordering::Relaxed),
            "lastError": err,
            "upMs": self.started.elapsed().as_millis() as u64,
        })
    }

    pub async fn stop(&self) {
        if let Some(t) = self.accept.lock().unwrap().take() {
            t.abort();
        }
        if let Some(c) = self.conn.lock().await.take() {
            c.close(0u32.into(), b"stopped");
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), self.ep.close()).await;
    }
}

/// Bytes both ways until each side ends; an end on one side finishes the other.
async fn pipe(tcp: TcpStream, mut send: iroh::endpoint::SendStream, mut recv: iroh::endpoint::RecvStream) {
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
