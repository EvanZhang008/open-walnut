//! The connector: one iroh endpoint with the phone's key, one connection to its Walnut (the
//! Mac's walnut-net, ALPN walnut/web/1), and a 127.0.0.1 port whose every TCP connection is a
//! stream on it. The app's HTTP client talks to the port as it would to the Mac on the LAN.
//!
//! The Mac checks this endpoint's id against its paired phones before any stream, and every
//! request through it still needs the device token, so the port gives nothing to another app
//! on the phone that connects to it (it reaches only what an unpaired caller of the Mac's
//! server reaches: who the box is).
//!
//! The other way round matters too: the app must send its token only to this listener, never
//! to another app that took the port. So the client says at every moment which port it holds
//! (`listening`, 0 while none: lost to the system, being rebound, stopped), the app starts a
//! request to the port only while it is that one (WalnutConnect.swift's guard), and `rebind` takes
//! the port again after iOS reclaimed a suspended app's listener (Apple TN2277).

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use iroh::endpoint::{Connection, ConnectionError, PortmapperConfig, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey, Watcher};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinHandle;

/// The protocol the Mac's walnut-net takes phones on (native/walnut-net/src/web.rs).
pub const ALPN_WEB: &[u8] = b"walnut/web/1";
/// The relay-first dial; after it, the known addresses get DIAL_TIMEOUT.
const RELAY_DIAL_TIMEOUT: Duration = Duration::from_secs(8);
const DIAL_TIMEOUT: Duration = Duration::from_secs(12);
/// Local connections at once, waiting or piping: below the Mac's 64 streams a connection
/// (native/walnut-net/src/web.rs), so a stream is never refused there. More are closed.
const MAX_STREAMS: usize = 60;
/// Accept errors in a row that mean the listener is gone (the system took it back).
const LOST_AFTER_ERRORS: u32 = 3;
/// After the Walnut refused this phone (not paired, or no longer): no new dial for this long.
const REFUSED_BACKOFF: Duration = Duration::from_secs(30);
/// The Walnut's close codes for a refused phone (native/walnut-net/src/node.rs).
const CLOSE_NOT_PAIRED: u32 = 403;
const CLOSE_REMOVED: u32 = 410;

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
    /// The port the app's routes name: the listener's, or the last one it had.
    port: AtomicU16,
    /// The port a listener of this client holds right now; 0 while none does.
    listening: AtomicU16,
    /// The accept loop, which owns the listener.
    accept: Mutex<Option<JoinHandle<()>>>,
    conn: Mutex<Option<Connection>>,
    /// One dial at a time.
    dialing: Mutex<()>,
    /// The last dial that failed: a request that waited on it gets its error, not a dial of its own.
    dial_failed: std::sync::Mutex<Option<(Instant, String)>>,
    /// Until when the Walnut's refusal holds (no dial meanwhile).
    refused_until: std::sync::Mutex<Option<Instant>>,
    last_error: std::sync::Mutex<Option<(String, Instant)>>,
    started: Instant,
    streams: AtomicU64,
    slots: Arc<Semaphore>,
}

/// A listener on 127.0.0.1: the port asked for while it is free, else any.
async fn bind(want: Option<u16>) -> Result<TcpListener> {
    if let Some(p) = want.filter(|p| *p != 0)
        && let Ok(l) = TcpListener::bind(("127.0.0.1", p)).await {
            return Ok(l);
        }
    TcpListener::bind(("127.0.0.1", 0)).await.context("listen on 127.0.0.1")
}

/// The Walnut's reason when it closed this connection on purpose: this phone is not (or no
/// longer) paired there. A replaced connection (409) or a dropped link is no refusal.
fn refusal(conn: &Connection) -> Option<String> {
    match conn.close_reason()? {
        ConnectionError::ApplicationClosed(c) if c.error_code == CLOSE_NOT_PAIRED.into() || c.error_code == CLOSE_REMOVED.into() => {
            Some(String::from_utf8_lossy(&c.reason).into_owned())
        }
        _ => None,
    }
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
        let want = cfg.port;
        let client = Arc::new(Self {
            ep,
            cfg: std::sync::Mutex::new(cfg),
            peer,
            port: AtomicU16::new(0),
            listening: AtomicU16::new(0),
            accept: Mutex::new(None),
            conn: Mutex::new(None),
            dialing: Mutex::new(()),
            dial_failed: std::sync::Mutex::new(None),
            refused_until: std::sync::Mutex::new(None),
            last_error: std::sync::Mutex::new(None),
            started: Instant::now(),
            streams: AtomicU64::new(0),
            slots: Arc::new(Semaphore::new(MAX_STREAMS)),
        });
        if let Err(e) = client.listen(want).await {
            client.stop().await;
            return Err(e);
        }
        Ok(client)
    }

    /// The port the app's routes name.
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    /// The port a listener of this client holds right now, 0 while none does.
    pub fn listening(&self) -> u16 {
        self.listening.load(Ordering::SeqCst)
    }

    /// Close the listener (waiting until its socket is closed) and listen again on `want`,
    /// else any port. Streams already piping go on.
    async fn listen(self: &Arc<Self>, want: Option<u16>) -> Result<u16> {
        let mut slot = self.accept.lock().await;
        self.listening.store(0, Ordering::SeqCst);
        if let Some(old) = slot.take() {
            old.abort();
            let _ = old.await;
        }
        let listener = bind(want).await?;
        let port = listener.local_addr()?.port();
        self.port.store(port, Ordering::SeqCst);
        self.listening.store(port, Ordering::SeqCst);
        let c = self.clone();
        *slot = Some(tokio::spawn(async move { c.serve(listener, port).await }));
        Ok(port)
    }

    /// Take the port again: after the app comes back from the background, or the listener was
    /// lost. The same port while it is free; the answer is the port it holds now.
    pub async fn rebind(self: &Arc<Self>) -> Result<u16> {
        self.listen(Some(self.port())).await
    }

    async fn serve(self: Arc<Self>, listener: TcpListener, port: u16) {
        let mut errors = 0u32;
        loop {
            let tcp = match listener.accept().await {
                Ok((tcp, from)) if from.ip().is_loopback() => {
                    errors = 0;
                    tcp
                }
                Ok(_) => continue,
                Err(e) => {
                    errors += 1;
                    if errors >= LOST_AFTER_ERRORS {
                        // Gone (iOS reclaims a suspended app's listener): say so, so the app sends
                        // nothing to this port until it is taken again.
                        let _ = self.listening.compare_exchange(port, 0, Ordering::SeqCst, Ordering::SeqCst);
                        self.note_error(format!("the local port stopped accepting: {e}"));
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            // Held for the stream's whole life, so a stream is never refused by the Mac's cap.
            let Ok(slot) = self.slots.clone().try_acquire_owned() else { continue };
            let c = self.clone();
            tokio::spawn(async move {
                let _slot = slot;
                let opened = async {
                    let conn = c.connection().await?;
                    match conn.open_bi().await {
                        Ok(s) => Ok(s),
                        Err(_) => {
                            // A connection that died since it was cached: dial once more,
                            // unless the Walnut closed it to refuse this phone.
                            c.forget(&conn).await;
                            Ok::<_, anyhow::Error>(c.connection().await?.open_bi().await?)
                        }
                    }
                };
                match opened.await {
                    Ok((send, recv)) => {
                        c.streams.fetch_add(1, Ordering::Relaxed);
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
        drop(cur);
        if let Some(why) = refusal(dead) {
            self.refused(why);
        }
    }

    fn refused(&self, why: String) {
        *self.refused_until.lock().unwrap() = Some(Instant::now() + REFUSED_BACKOFF);
        self.note_error(format!("not_paired: your Walnut does not let this phone in ({why})"));
    }

    /// The cached connection while it is open; a closed one is dropped (and a refusal kept).
    async fn live(&self) -> Option<Connection> {
        let mut cur = self.conn.lock().await;
        match cur.as_ref() {
            Some(c) if c.close_reason().is_none() => Some(c.clone()),
            Some(c) => {
                let why = refusal(c);
                *cur = None;
                drop(cur);
                if let Some(why) = why {
                    self.refused(why);
                }
                None
            }
            None => None,
        }
    }

    /// The live connection to the Walnut, dialled when there is none. Requests that wait on a
    /// dial that fails get its error at once; after a refusal nothing dials for a while.
    pub async fn connection(&self) -> Result<Connection> {
        if let Some(c) = self.live().await {
            return Ok(c);
        }
        let asked = Instant::now();
        let _one = self.dialing.lock().await;
        if let Some(c) = self.live().await {
            return Ok(c);
        }
        if self.refused_until.lock().unwrap().is_some_and(|until| Instant::now() < until) {
            bail!("your Walnut does not let this phone in (not paired there any more)");
        }
        if let Some((at, e)) = self.dial_failed.lock().unwrap().clone()
            && at >= asked {
                bail!("{e}");
            }
        match self.dial().await {
            Ok(conn) => {
                *self.dial_failed.lock().unwrap() = None;
                Ok(self.keep(conn).await)
            }
            Err(e) => {
                let msg = format!("{e:#}");
                *self.dial_failed.lock().unwrap() = Some((Instant::now(), msg.clone()));
                self.note_error(msg);
                Err(e)
            }
        }
    }

    async fn dial(&self) -> Result<Connection> {
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
                Ok(Ok(conn)) => return Ok(conn),
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
        tokio::time::timeout(DIAL_TIMEOUT, self.ep.connect(addr, ALPN_WEB))
            .await
            .map_err(|_| anyhow!("your Walnut did not answer in {}s", DIAL_TIMEOUT.as_secs()))?
            .context("could not reach your Walnut")
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
            "port": self.port(),
            "listening": self.listening(),
            "relayMode": match self.config().choice() { RelayChoice::Public => "public", RelayChoice::Custom => "custom", RelayChoice::None => "none" },
            "relays": relays,
            "link": link,
            "streams": self.streams.load(Ordering::Relaxed),
            "lastError": err,
            "upMs": self.started.elapsed().as_millis() as u64,
        })
    }

    pub async fn stop(&self) {
        self.listening.store(0, Ordering::SeqCst);
        if let Some(t) = self.accept.lock().await.take() {
            // Awaited, so the port is free before a start that follows binds it again.
            t.abort();
            let _ = t.await;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn config(port: Option<u16>) -> Config {
        Config {
            key: "11".repeat(32),
            peer: Peer { id: secret_key(&"22".repeat(32)).unwrap().public().to_string(), relays: vec![], addrs: vec![] },
            relay_mode: Some(RelayChoice::None),
            relays: vec![],
            relay_roots: vec![],
            port,
        }
    }

    /// The app trusts the port only while `listening` names it: a stopped client says 0, a
    /// rebind keeps the port while it is free, and a port another program took is never claimed.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_client_says_which_port_it_holds_and_never_claims_a_taken_one() {
        let c = Client::start(config(None)).await.unwrap();
        let p = c.port();
        assert_ne!(p, 0);
        assert_eq!(c.listening(), p);
        assert!(TcpStream::connect(("127.0.0.1", p)).await.is_ok());

        // Back from the background: the same port again.
        assert_eq!(c.rebind().await.unwrap(), p);
        assert_eq!(c.listening(), p);

        // Stopped: nothing holds it, and the app is told so.
        c.stop().await;
        assert_eq!(c.listening(), 0);

        // Another program takes the port meanwhile: a new start gets another one and says so.
        let squatter = TcpListener::bind(("127.0.0.1", p)).await.unwrap();
        let d = Client::start(config(Some(p))).await.unwrap();
        assert_ne!(d.port(), p);
        assert_eq!(d.listening(), d.port());
        // And a rebind asking for it while it is still taken moves on too.
        d.listen(Some(p)).await.unwrap();
        assert_ne!(d.listening(), p);
        drop(squatter);
        d.stop().await;
    }

}
