//! Endpoints in relayMode none over loopback, driven through the control ops: the join protocol,
//! and the member check on daemon connections that must not loosen because of it.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use iroh::EndpointAddr;
use iroh::endpoint::{ApplicationClose, Connection, ConnectionError};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::config::Config;
use crate::control::{Event, handle};
use crate::invites::{code_hash, now_ms};
use crate::join::ALPN_JOIN;
use crate::node::{ALPN_DAEMON, Node};

const CODE: &str = "ABCDEFGHJKLM";
const CODE2: &str = "NPQRSTUVWXYZ";
const CODE3: &str = "23456789ABCD";
const WRONG: &str = "ZZZZ-ZZZZ-ZZZZ";

struct Host {
    node: Arc<Node>,
    dir: PathBuf,
    events: mpsc::Sender<Event>,
    _rx: mpsc::Receiver<Event>,
}

fn cfg(dir: &std::path::Path, members: Value) -> Config {
    serde_json::from_value(json!({
        "version": 1, "relayMode": "none", "bindPort": 0, "members": members,
        "key": dir.join("net.key"), "daemonPortFile": dir.join("daemon.port"), "control": dir.join("control.sock"),
    }))
    .unwrap()
}

async fn host() -> Host {
    let dir = std::env::temp_dir().join(format!("walnut-net-join-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&dir).unwrap();
    let node = Node::bind(&cfg(&dir, json!([]))).await.unwrap();
    tokio::spawn(node.clone().serve());
    let (events, _rx) = mpsc::channel(1);
    Host { node, dir, events, _rx }
}

impl Host {
    async fn op(&self, req: Value) -> Value {
        match handle(&req.to_string(), &self.node, &self.events).await {
            Ok(v) => v,
            Err(e) => json!({"ok": false, "error": format!("{e:#}")}),
        }
    }

    fn id(&self) -> String {
        self.node.ep.id().to_string()
    }

    fn addr(&self) -> std::net::SocketAddr {
        let port = self.node.ep.bound_sockets().iter().find(|a| a.is_ipv4()).expect("an IPv4 socket").port();
        std::net::SocketAddr::from(([127, 0, 0, 1], port))
    }

    async fn join(&self, to: &Host, code: &str) -> Value {
        self.op(json!({
            "op": "join", "to": to.id(), "code": code, "hostname": "box.example.test", "platform": "linux-x64",
            "addrs": [to.addr().to_string()], "relay": null,
        }))
        .await
    }

    async fn invites(&self, list: Value) {
        assert_eq!(self.op(json!({"op": "invites", "invites": list})).await, json!({"ok": true}));
    }

    /// A raw connection to `to` on this ALPN, with one stream opened and written to.
    async fn dial(&self, to: &Host, alpn: &[u8]) -> Connection {
        let addr = EndpointAddr::new(to.node.ep.id()).with_ip_addr(to.addr());
        let conn = timeout(Duration::from_secs(10), self.node.ep.connect(addr, alpn)).await.unwrap().unwrap();
        if let Ok((mut send, _recv)) = conn.open_bi().await {
            let _ = send.write_all(b"hello").await;
            let _ = send.finish();
        }
        conn
    }

    async fn done(self) {
        self.node.ep.close().await;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn invite(id: &str, code: &str, expires_at: u64, name: Option<&str>) -> Value {
    let hash: String = code_hash(code).iter().map(|b| format!("{b:02x}")).collect();
    json!({"id": id, "codeHash": hash, "expiresAt": expires_at, "name": name})
}

fn closed_with(code: u32, reason: &[u8]) -> ConnectionError {
    ConnectionError::ApplicationClosed(ApplicationClose { error_code: code.into(), reason: reason.to_vec().into() })
}

fn invalid() -> Value {
    json!({"ok": false, "error": "invalid_code"})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_join_over_loopback_uses_its_invite_once() {
    let (a, b) = (host().await, host().await);
    let later = now_ms() + 600_000;
    a.invites(json!([invite("i1", CODE, later, None), invite("i2", CODE2, later, Some("gpu")), invite("i3", CODE3, now_ms() - 1, None)])).await;

    assert_eq!(b.join(&a, WRONG).await, invalid());
    assert_eq!(b.join(&a, "2345-6789-abcd").await, invalid(), "an expired invite");
    assert_eq!(b.join(&a, "abcd-efgh-jklm").await, json!({"ok": true, "name": "box"}));

    let s = a.op(json!({"op": "status"})).await;
    assert_eq!(s["relayMode"], "none");
    assert_eq!(s["homeRelay"], Value::Null);
    let used = &s["invites"][0]["used"];
    assert_eq!(s["invites"][0]["id"], "i1");
    assert_eq!(s["invites"][0]["expiresAt"], later);
    assert_eq!(used["memberId"], b.id());
    assert_eq!((&used["hostname"], &used["platform"], &used["name"]), (&json!("box.example.test"), &json!("linux-x64"), &json!("box")));
    assert!(used["at"].as_u64().unwrap() <= now_ms());
    // Where the machine is: the address the join came from first (with no relay, how this
    // host reaches it later), then the ones it named, each with the port it listens on.
    assert_eq!(used["addrs"][0], b.addr().to_string());
    let port = b.addr().port();
    assert!(used["addrs"].as_array().unwrap().iter().all(|a| a.as_str().unwrap().ends_with(&format!(":{port}"))), "{used}");
    assert_eq!(s["invites"][1]["used"], Value::Null);
    assert_eq!(s["invites"][2]["used"], Value::Null);
    // Joining does not make a member.
    assert_eq!(s["peers"], json!([]));

    assert_eq!(b.join(&a, CODE).await, invalid(), "a second use");
    assert_eq!(b.join(&a, "NPQR STUV WXYZ").await, json!({"ok": true, "name": "gpu"}));
    // Nothing is pending now: the connection is closed before any stream, which the joiner
    // reads as a link that is no longer valid.
    assert_eq!(b.join(&a, CODE).await, invalid());
    // The daemon sending a used invite again does not open it again.
    a.invites(json!([invite("i1", CODE, later, None)])).await;
    assert_eq!(a.op(json!({"op": "status"})).await["invites"][0]["used"]["memberId"], b.id());
    assert_eq!(b.join(&a, CODE).await, invalid());
    a.done().await;
    b.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_no_pending_invite_a_join_is_closed_before_any_stream() {
    let (a, b) = (host().await, host().await);
    let conn = b.dial(&a, ALPN_JOIN).await;
    assert_eq!(timeout(Duration::from_secs(5), conn.closed()).await.unwrap(), closed_with(403, b"no invite"));
    assert_eq!(b.join(&a, CODE).await, invalid());
    // Only an expired invite: the same.
    a.invites(json!([invite("old", CODE, now_ms() - 1, None)])).await;
    let conn = b.dial(&a, ALPN_JOIN).await;
    assert_eq!(timeout(Duration::from_secs(5), conn.closed()).await.unwrap(), closed_with(403, b"no invite"));
    assert_eq!(b.join(&a, CODE).await, invalid());
    a.done().await;
    b.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_non_member_still_cannot_open_a_daemon_stream() {
    let (a, b) = (host().await, host().await);
    let daemon = TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::fs::write(a.dir.join("daemon.port"), daemon.local_addr().unwrap().port().to_string()).unwrap();
    // A pending invite, and even a used one, opens nothing on the daemon protocol.
    a.invites(json!([invite("i1", CODE, now_ms() + 600_000, None), invite("i2", CODE2, now_ms() + 600_000, None)])).await;
    assert_eq!(b.join(&a, CODE).await["ok"], true);
    for members in [json!([]), json!([{"id": b.id(), "name": "box", "accept": false}])] {
        a.node.set_members(&cfg(&a.dir, members)).await.unwrap();
        let conn = b.dial(&a, ALPN_DAEMON).await;
        assert_eq!(timeout(Duration::from_secs(5), conn.closed()).await.unwrap(), closed_with(403, b"not a member"));
        assert!(timeout(Duration::from_millis(500), daemon.accept()).await.is_err(), "nothing reaches the daemon");
    }
    // The control: a member allowed in reaches the daemon over the same path.
    a.node.set_members(&cfg(&a.dir, json!([{"id": b.id(), "name": "box", "accept": true}]))).await.unwrap();
    let conn = b.dial(&a, ALPN_DAEMON).await;
    let (mut sock, _) = timeout(Duration::from_secs(5), daemon.accept()).await.unwrap().unwrap();
    let mut got = [0u8; 5];
    sock.read_exact(&mut got).await.unwrap();
    assert_eq!(&got, b"hello");
    conn.close(0u32.into(), b"done");
    a.done().await;
    b.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_joins_with_one_code_at_once_let_one_machine_in() {
    let (a, b, c) = (host().await, host().await, host().await);
    let later = now_ms() + 600_000;
    a.invites(json!([invite("i1", CODE, later, None), invite("i2", CODE2, later, None)])).await;
    let (rb, rc) = tokio::join!(b.join(&a, CODE), c.join(&a, CODE));
    let wins: Vec<_> = [(&rb, b.id()), (&rc, c.id())].into_iter().filter(|(r, _)| r["ok"] == true).collect();
    assert_eq!(wins.len(), 1, "{rb} {rc}");
    assert!(rb == invalid() || rc == invalid(), "{rb} {rc}");
    let s = a.op(json!({"op": "status"})).await;
    assert_eq!(s["invites"][0]["used"]["memberId"], wins[0].1);
    assert_eq!(s["invites"][1]["used"], Value::Null);
    a.done().await;
    b.done().await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn five_wrong_codes_rate_limit_the_peer_over_the_wire() {
    let (a, b, c) = (host().await, host().await, host().await);
    a.invites(json!([invite("i1", CODE, now_ms() + 600_000, None)])).await;
    for _ in 0..5 {
        assert_eq!(b.join(&a, WRONG).await, invalid());
    }
    assert_eq!(b.join(&a, CODE).await, json!({"ok": false, "error": "rate_limited"}));
    assert_eq!(a.op(json!({"op": "status"})).await["invites"][0]["used"], Value::Null);
    assert_eq!(c.join(&a, CODE).await, json!({"ok": true, "name": "box"}));
    a.done().await;
    b.done().await;
    c.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_ops_refuse_bad_input_and_keep_what_they_had() {
    let a = host().await;
    let id = a.id();
    a.invites(json!([invite("i1", CODE, now_ms() + 600_000, None)])).await;
    let refused = |v: Value| v["ok"] == false && v["error"].as_str().is_some_and(|e| !["invalid_code", "rate_limited", "no_answer"].contains(&e));
    for bad in [
        json!({"op": "invites"}),
        json!({"op": "invites", "invites": [{"id": "x", "codeHash": "00", "expiresAt": 1}]}),
        json!({"op": "join", "to": "nothex", "code": CODE, "addrs": ["127.0.0.1:1"]}),
        json!({"op": "join", "to": id, "addrs": ["127.0.0.1:1"]}),
        json!({"op": "join", "to": id, "code": CODE, "addrs": ["nope"]}),
        json!({"op": "join", "to": id, "code": CODE, "addrs": "127.0.0.1:1"}),
        // relayMode none with nothing to dial.
        json!({"op": "join", "to": id, "code": CODE, "addrs": [], "relay": null}),
        json!({"op": "join", "to": id, "code": CODE, "relay": "not a url"}),
    ] {
        let r = a.op(bad.clone()).await;
        assert!(refused(r.clone()), "{bad} -> {r}");
    }
    let s = a.op(json!({"op": "status"})).await;
    assert_eq!(s["invites"].as_array().unwrap().len(), 1);
    assert_eq!(s["invites"][0]["id"], "i1");
    a.done().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_listens_on_the_port_it_had_and_a_taken_one_is_not_fatal() {
    let dir = std::env::temp_dir().join(format!("walnut-net-port-{}-{}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&dir).unwrap();
    let port = |n: &Node| n.ep.bound_sockets().iter().find(|a| a.is_ipv4()).unwrap().port();
    let first = Node::bind(&cfg(&dir, json!([]))).await.unwrap();
    let p = port(&first);
    assert_eq!(std::fs::read_to_string(dir.join("net.key.port")).unwrap().trim(), p.to_string());
    // Taken (the first one still runs): another port, and the file names that one.
    let second = Node::bind(&cfg(&dir, json!([]))).await.unwrap();
    assert_ne!(port(&second), p);
    second.ep.close().await;
    first.ep.close().await;
    drop((first, second));
    // Free again: the port it has kept.
    let kept: u16 = std::fs::read_to_string(dir.join("net.key.port")).unwrap().trim().parse().unwrap();
    let third = Node::bind(&cfg(&dir, json!([]))).await.unwrap();
    assert_eq!(port(&third), kept);
    third.ep.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}
