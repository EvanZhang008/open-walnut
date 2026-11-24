//! Walnut Connect over loopback (relayMode none): only a listed phone reaches the server's
//! connect door, a phone never reaches the daemon, a member never reaches the door, and a
//! phone taken off the list is cut at once.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use iroh::EndpointAddr;
use iroh::endpoint::{ApplicationClose, Connection, ConnectionError};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UnixListener};
use tokio::time::timeout;

use crate::config::Config;
use crate::node::{ALPN_DAEMON, Node};
use crate::web::ALPN_WEB;

struct Host {
    node: Arc<Node>,
    dir: PathBuf,
}

fn cfg(dir: &std::path::Path, extra: Value) -> Config {
    let mut v = json!({
        "version": 1, "relayMode": "none", "bindPort": 0,
        "key": dir.join("net.key"), "daemonPortFile": dir.join("daemon.port"), "control": dir.join("control.sock"),
    });
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    serde_json::from_value(v).unwrap()
}

async fn host(extra: Value) -> Host {
    let dir = std::env::temp_dir().join(format!("wn-web-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&dir).unwrap();
    let node = Node::bind(&cfg(&dir, extra)).await.unwrap();
    tokio::spawn(node.clone().serve());
    Host { node, dir }
}

impl Host {
    fn id(&self) -> String {
        self.node.ep.id().to_string()
    }

    fn addr(&self) -> std::net::SocketAddr {
        let port = self.node.ep.bound_sockets().iter().find(|a| a.is_ipv4()).expect("an IPv4 socket").port();
        std::net::SocketAddr::from(([127, 0, 0, 1], port))
    }

    fn door(&self) -> PathBuf {
        self.dir.join("door.sock")
    }

    async fn reload(&self, extra: Value) {
        self.node.set_members(&cfg(&self.dir, extra)).await.unwrap();
    }

    async fn dial(&self, to: &Host, alpn: &[u8]) -> Connection {
        let addr = EndpointAddr::new(to.node.ep.id()).with_ip_addr(to.addr());
        timeout(Duration::from_secs(10), self.node.ep.connect(addr, alpn)).await.unwrap().unwrap()
    }

    async fn done(self) {
        self.node.ep.close().await;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn closed_with(code: u32, reason: &[u8]) -> ConnectionError {
    ConnectionError::ApplicationClosed(ApplicationClose { error_code: code.into(), reason: reason.to_vec().into() })
}

/// The server's connect door: answers each connection with what it read, uppercased.
fn door(path: &std::path::Path) -> tokio::task::JoinHandle<()> {
    let l = UnixListener::bind(path).unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 64];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let _ = s.write_all(&buf[..n].to_ascii_uppercase()).await;
                let _ = s.shutdown().await;
            });
        }
    })
}

/// One stream: write `msg`, finish, read everything back.
async fn round_trip(conn: &Connection, msg: &[u8]) -> Vec<u8> {
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    send.write_all(msg).await.unwrap();
    send.finish().unwrap();
    timeout(Duration::from_secs(5), recv.read_to_end(1024)).await.unwrap().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_listed_phone_reaches_the_door_and_nothing_else_does() {
    let phone = host(json!({})).await;
    let other = host(json!({})).await;
    let mac = host(json!({})).await;
    let _door = door(&mac.door());
    let daemon = TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::fs::write(mac.dir.join("daemon.port"), daemon.local_addr().unwrap().port().to_string()).unwrap();
    let web = |phones: Value| json!({"phones": phones, "webSocket": mac.door(), "members": [{"id": other.id(), "name": "box", "accept": true}]});
    mac.reload(web(json!([{"id": phone.id(), "name": "iPhone"}]))).await;

    // The phone: each stream is one round trip to the door.
    let conn = phone.dial(&mac, ALPN_WEB).await;
    assert_eq!(round_trip(&conn, b"get /api/v1/instance").await, b"GET /API/V1/INSTANCE");
    assert_eq!(round_trip(&conn, b"again").await, b"AGAIN");
    let s = mac.node.status().await;
    assert_eq!(s["web"]["phones"][0]["id"], phone.id());
    assert_eq!(s["web"]["phones"][0]["name"], "iPhone");
    assert_eq!(s["web"]["phones"][0]["connections"], 1);

    // A phone is not a member: the daemon protocol refuses it before any stream.
    let d = phone.dial(&mac, ALPN_DAEMON).await;
    if let Ok((mut send, _)) = d.open_bi().await {
        let _ = send.write_all(b"hello").await;
        let _ = send.finish();
    }
    assert_eq!(timeout(Duration::from_secs(5), d.closed()).await.unwrap(), closed_with(403, b"not a member"));
    assert!(timeout(Duration::from_millis(500), daemon.accept()).await.is_err(), "a phone never reaches the daemon");

    // A member (even one allowed on the daemon) is not a phone.
    let m = other.dial(&mac, ALPN_WEB).await;
    assert_eq!(timeout(Duration::from_secs(5), m.closed()).await.unwrap(), closed_with(403, b"not paired"));

    // Taken off the list: its live connection is cut, and a new one is refused.
    mac.reload(web(json!([]))).await;
    assert_eq!(timeout(Duration::from_secs(5), conn.closed()).await.unwrap(), closed_with(410, b"no longer paired"));
    let again = phone.dial(&mac, ALPN_WEB).await;
    assert_eq!(timeout(Duration::from_secs(5), again.closed()).await.unwrap(), closed_with(403, b"not paired"));

    phone.done().await;
    other.done().await;
    mac.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_no_door_even_a_listed_phone_is_refused_and_a_dead_door_resets_the_stream() {
    let phone = host(json!({})).await;
    let mac = host(json!({})).await;
    mac.reload(json!({"phones": [{"id": phone.id()}]})).await;
    let conn = phone.dial(&mac, ALPN_WEB).await;
    assert_eq!(timeout(Duration::from_secs(5), conn.closed()).await.unwrap(), closed_with(403, b"not paired"));

    // A door named but nothing listening (the server restarting): the stream is reset, the
    // connection stays, and the next stream gets through once the door is back.
    mac.reload(json!({"phones": [{"id": phone.id()}], "webSocket": mac.door()})).await;
    let conn = phone.dial(&mac, ALPN_WEB).await;
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    send.write_all(b"x").await.unwrap();
    send.finish().unwrap();
    assert!(timeout(Duration::from_secs(5), recv.read_to_end(64)).await.unwrap().is_err(), "reset, not an empty answer");
    let _door = door(&mac.door());
    assert_eq!(round_trip(&conn, b"back").await, b"BACK");
    phone.done().await;
    mac.done().await;
}
