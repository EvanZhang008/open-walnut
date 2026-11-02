//! The invites a host has open for joins, how a join request is checked against them, and the
//! join rate limits. The protocol around it is in join.rs.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use iroh::EndpointId;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::log;

const WINDOW: Duration = Duration::from_secs(600);
const PEER_FAILS: usize = 5;
const ALL_FAILS: usize = 30;
/// Join connections answered at once; more are closed (each may hold a task for up to 25 s).
const MAX_OPEN: usize = 16;

/// Direct addresses kept for a machine that joined.
const MAX_ADDRS: usize = 8;

const ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Names the daemon keeps for itself (net-store.ts RESERVED).
const RESERVED: [&str; 6] = ["local", "__local__", "__cloudbox__", "cloud", "companion", "mac"];

#[derive(Debug, Clone)]
struct Used {
    member_id: String,
    hostname: String,
    platform: String,
    name: String,
    at: u64,
    /// Where the machine can be reached directly: the address its join came from, then the
    /// ones it named. With no relay these are the only way this host finds it again.
    addrs: Vec<String>,
}

#[derive(Debug)]
struct Invite {
    id: String,
    hash: [u8; 32],
    expires_at: u64,
    name: Option<String>,
    used: Option<Used>,
}

impl Invite {
    /// Not used and not expired. `expiresAt` itself still counts, as in net-store.ts.
    fn open(&self, now_ms: u64) -> bool {
        self.used.is_none() && now_ms <= self.expires_at
    }
}

#[derive(Default)]
struct State {
    invites: Vec<Invite>,
    fails: VecDeque<Instant>,
    peer_fails: HashMap<EndpointId, VecDeque<Instant>>,
}

#[derive(Default)]
pub struct Joins {
    state: Mutex<State>,
    open: AtomicUsize,
}

/// Holds one of the MAX_OPEN places until dropped.
pub struct Slot<'a>(&'a AtomicUsize);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Joins {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // A panic aborts the process (panic=abort), so a poisoned lock cannot be seen; take it anyway.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The `invites` control op: replaces the pending set. An id already used keeps its used record.
    pub fn set(&self, list: &Value) -> Result<()> {
        let list = list.as_array().ok_or_else(|| anyhow!("`invites` (a list) is required"))?;
        let mut next: Vec<Invite> = vec![];
        for v in list {
            let id = v.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("an invite needs an `id`"))?;
            let hash = v
                .get("codeHash")
                .and_then(Value::as_str)
                .and_then(hex32)
                .ok_or_else(|| anyhow!("invite {id}: `codeHash` is not 64 hex characters"))?;
            let expires_at = v.get("expiresAt").and_then(ms).ok_or_else(|| anyhow!("invite {id}: `expiresAt` is not a time in ms"))?;
            let name = match v.get("name") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if s.is_empty() => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(_) => bail!("invite {id}: `name` is not a string"),
            };
            if next.iter().any(|i| i.id == id) {
                bail!("invite {id} is listed twice");
            }
            next.push(Invite { id: id.to_string(), hash, expires_at, name, used: None });
        }
        let mut st = self.lock();
        for inv in &mut next {
            if let Some(old) = st.invites.iter().find(|o| o.id == inv.id) {
                inv.used = old.used.clone();
            }
        }
        st.invites = next;
        Ok(())
    }

    pub fn pending(&self, now_ms: u64) -> bool {
        self.lock().invites.iter().any(|i| i.open(now_ms))
    }

    pub fn status(&self) -> Value {
        let st = self.lock();
        Value::Array(
            st.invites
                .iter()
                .map(|i| {
                    let used = i.used.as_ref().map(|u| {
                        json!({"memberId": u.member_id, "hostname": u.hostname, "platform": u.platform, "name": u.name, "at": u.at, "addrs": u.addrs})
                    });
                    json!({"id": i.id, "expiresAt": i.expires_at, "used": used})
                })
                .collect(),
        )
    }

    pub fn slot(&self) -> Option<Slot<'_>> {
        if self.open.fetch_add(1, Ordering::SeqCst) >= MAX_OPEN {
            self.open.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Slot(&self.open))
    }

    /// Check one join request line (None: longer than MAX_LINE) and answer it. A match uses the
    /// invite under the same lock, so one code can never let two machines in.
    #[cfg(test)]
    pub fn check(&self, peer: EndpointId, line: Option<&[u8]>, now_ms: u64, now: Instant) -> Value {
        self.check_from(peer, line, &[], now_ms, now)
    }

    /// `check`, for a join that came in from `seen` (its direct paths, if any).
    pub fn check_from(&self, peer: EndpointId, line: Option<&[u8]>, seen: &[SocketAddr], now_ms: u64, now: Instant) -> Value {
        let mut st = self.lock();
        st.prune(now);
        if st.limited(&peer) {
            // Debug only: a limited peer may keep trying, and the log must not grow with it.
            log::debug("join refused: too many wrong codes", json!({"peer": peer.to_string()}));
            return json!({"ok": false, "error": "rate_limited"});
        }
        let req: Option<Value> = line.and_then(|l| serde_json::from_slice(l).ok());
        let field = |k: &str| req.as_ref().and_then(|r| r.get(k)).and_then(Value::as_str).unwrap_or("").to_string();
        let hit = req
            .as_ref()
            .and_then(|r| r.get("code"))
            .and_then(Value::as_str)
            .and_then(normal_code)
            .and_then(|c| st.find(&code_hash(&c), now_ms));
        let Some(i) = hit else {
            st.fail(peer, now);
            log::warn("join refused: wrong code", json!({"peer": peer.to_string()}));
            return json!({"ok": false, "error": "invalid_code"});
        };
        let hostname = field("hostname");
        let named = req.as_ref().and_then(|r| r.get("addrs")).and_then(Value::as_array).cloned().unwrap_or_default();
        let mut addrs: Vec<String> = vec![];
        for a in seen.iter().copied().chain(named.iter().filter_map(|v| v.as_str()?.parse::<SocketAddr>().ok())) {
            let a = a.to_string();
            if addrs.len() < MAX_ADDRS && !addrs.contains(&a) {
                addrs.push(a);
            }
        }
        let inv = &mut st.invites[i];
        let name = inv.name.clone().unwrap_or_else(|| name_from_host(&hostname));
        inv.used = Some(Used { member_id: peer.to_string(), hostname: hostname.clone(), platform: field("platform"), name: name.clone(), at: now_ms, addrs });
        log::info("invite used", json!({"invite": inv.id, "peer": peer.to_string(), "hostname": hostname, "name": name}));
        json!({"ok": true, "name": name})
    }
}

impl State {
    fn prune(&mut self, now: Instant) {
        let old = |t: &Instant| now.saturating_duration_since(*t) >= WINDOW;
        while self.fails.front().is_some_and(old) {
            self.fails.pop_front();
        }
        self.peer_fails.retain(|_, q| {
            while q.front().is_some_and(old) {
                q.pop_front();
            }
            !q.is_empty()
        });
    }

    fn limited(&self, peer: &EndpointId) -> bool {
        self.fails.len() >= ALL_FAILS || self.peer_fails.get(peer).is_some_and(|q| q.len() >= PEER_FAILS)
    }

    fn fail(&mut self, peer: EndpointId, now: Instant) {
        self.fails.push_back(now);
        self.peer_fails.entry(peer).or_default().push_back(now);
    }

    /// The pending invite with this hash. Every invite is compared, in constant time, with no early exit.
    fn find(&self, hash: &[u8; 32], now_ms: u64) -> Option<usize> {
        let mut hit = None;
        for (i, inv) in self.invites.iter().enumerate() {
            let same = ct_eq(&inv.hash, hash);
            if same && inv.open(now_ms) {
                hit = Some(i);
            }
        }
        hit
    }
}

/// The code as a person types it, the way net-store.ts `normalInviteCode` reads it: uppercase,
/// whitespace and `-` removed, then exactly 12 characters of ALPHABET.
pub fn normal_code(s: &str) -> Option<String> {
    // JavaScript's `\s`: Unicode White_Space without U+0085, plus U+FEFF.
    let js_space = |c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}';
    let t: String = s.to_uppercase().chars().filter(|c| !js_space(*c) && *c != '-').collect();
    (t.chars().count() == 12 && t.chars().all(|c| ALPHABET.contains(c))).then_some(t)
}

/// SHA-256 of the normalized code (12 characters, no dashes).
pub fn code_hash(code: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(code.as_bytes()));
    out
}

/// A member name made from a host name, the way net-store.ts `memberNameFrom` makes it: the
/// first DNS label, each run of other characters than `[A-Za-z0-9_-]` one `-`, trimmed of `-`,
/// at most 40 characters; `machine` when that is empty or not a name the daemon takes.
pub fn name_from_host(raw: &str) -> String {
    let label = raw.split('.').next().unwrap_or("");
    let mut out = String::new();
    let mut in_run = false;
    for c in label.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let base: String = out.trim_matches('-').chars().take(40).collect();
    let starts_ok = base.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    if starts_ok && !RESERVED.contains(&base.to_ascii_lowercase().as_str()) { base } else { "machine".to_string() }
}

fn ct_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut d = 0u8;
    for i in 0..32 {
        d |= a[i] ^ b[i];
    }
    std::hint::black_box(d) == 0
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let nib = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = [0u8; 32];
    for (i, pair) in b.chunks(2).enumerate() {
        out[i] = nib(pair[0])? << 4 | nib(pair[1])?;
    }
    Some(out)
}

fn ms(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_f64().filter(|f| f.is_finite() && *f >= 0.0).map(|f| f as u64))
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn peer(n: u8) -> EndpointId {
        iroh::SecretKey::from_bytes(&[n; 32]).public()
    }

    fn joins_with(list: Value) -> Joins {
        let j = Joins::default();
        j.set(&list).unwrap();
        j
    }

    fn line(code: &str) -> Vec<u8> {
        json!({"code": code, "hostname": "box.example.test", "platform": "linux-x64"}).to_string().into_bytes()
    }

    const NOW: u64 = 1_700_000_000_000;

    #[test]
    fn codes_are_normalized_like_the_daemon_does() {
        assert_eq!(normal_code("ABCD-EFGH-JKLM").as_deref(), Some("ABCDEFGHJKLM"));
        assert_eq!(normal_code(" abcd efgh\tjklm\n").as_deref(), Some("ABCDEFGHJKLM"));
        assert_eq!(normal_code("a-b-c-d-e-f-g-h-j-k-l-m").as_deref(), Some("ABCDEFGHJKLM"));
        // Non-breaking space and BOM are `\s` in JavaScript.
        assert_eq!(normal_code("ABCD\u{a0}EFGH\u{feff}JKLM").as_deref(), Some("ABCDEFGHJKLM"));
        // U+0085 is not `\s` in JavaScript, so it stays and the code is invalid there too.
        assert_eq!(normal_code("ABCD\u{85}EFGHJKLM"), None);
        // Long s uppercases to S in both languages.
        assert_eq!(normal_code("\u{17f}BCDEFGHJKLM").as_deref(), Some("SBCDEFGHJKLM"));
        for bad in ["", "ABCDEFGHJKL", "ABCDEFGHJKLMN", "ABCDEFGHIKLM", "ABCDEFGH0KLM", "ABCDEFGH1KLM", "ABCDEFGHOKLM", "ABCD_EFGH_JKLM"] {
            assert_eq!(normal_code(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_hash_is_sha256_of_the_12_characters() {
        assert_eq!(hex(&code_hash("ABCDEFGHJKLM")), "3f63d25fcb898ecfd6c2e2322bfdb11f44fe17dd0dc359e70b7246224bb223e9");
        assert_eq!(hex32(&hex(&code_hash("ABCDEFGHJKLM"))), Some(code_hash("ABCDEFGHJKLM")));
        assert_eq!(hex32(&hex(&code_hash("ABCDEFGHJKLM")).to_uppercase()), Some(code_hash("ABCDEFGHJKLM")));
        assert_eq!(hex32("abc"), None);
        assert_eq!(hex32(&"g".repeat(64)), None);
        assert!(ct_eq(&[7; 32], &[7; 32]));
        let mut other = [7u8; 32];
        other[31] = 8;
        assert!(!ct_eq(&[7; 32], &other));
    }

    #[test]
    fn names_are_made_from_host_names_like_the_daemon_does() {
        assert_eq!(name_from_host("box.example.test"), "box");
        assert_eq!(name_from_host("My Box (2)"), "My-Box-2");
        assert_eq!(name_from_host("--gpu--"), "gpu");
        assert_eq!(name_from_host("a-\u{e9}b"), "a--b");
        assert_eq!(name_from_host(&"x".repeat(60)), "x".repeat(40));
        for empty in ["", ".", "---", "\u{e9}\u{e9}", "_under", "mac", "Cloud.example.test", "local"] {
            assert_eq!(name_from_host(empty), "machine", "{empty:?}");
        }
    }

    #[test]
    fn a_right_code_uses_the_invite_once() {
        let h = hex(&code_hash("ABCDEFGHJKLM"));
        let j = joins_with(json!([{"id": "a", "codeHash": h, "expiresAt": NOW + 60_000, "name": null}]));
        assert!(j.pending(NOW));
        let t = Instant::now();
        let r = j.check(peer(1), Some(&line("abcd-efgh-jklm")), NOW, t);
        assert_eq!(r, json!({"ok": true, "name": "box"}));
        assert!(!j.pending(NOW));
        let s = j.status();
        assert_eq!(s[0]["used"], json!({"memberId": peer(1).to_string(), "hostname": "box.example.test", "platform": "linux-x64", "name": "box", "at": NOW, "addrs": []}));
        assert_eq!(j.check(peer(2), Some(&line("ABCDEFGHJKLM")), NOW, t)["error"], "invalid_code");
        // Sent again by the daemon: still used.
        j.set(&json!([{"id": "a", "codeHash": h, "expiresAt": NOW + 60_000}])).unwrap();
        assert!(!j.pending(NOW));
        assert_eq!(j.status()[0]["used"]["memberId"], peer(1).to_string());
        // Left out: gone.
        j.set(&json!([])).unwrap();
        assert_eq!(j.status(), json!([]));
    }

    #[test]
    fn expired_wrong_and_malformed_requests_fail() {
        let h = hex(&code_hash("ABCDEFGHJKLM"));
        let j = joins_with(json!([{"id": "a", "codeHash": h, "expiresAt": NOW, "name": "gpu"}]));
        let t = Instant::now();
        assert!(!j.pending(NOW + 1));
        assert_eq!(j.check(peer(1), Some(&line("ABCDEFGHJKLM")), NOW + 1, t)["error"], "invalid_code");
        assert!(j.pending(NOW));
        assert_eq!(j.check(peer(1), Some(&line("ABCDEFGHJKLM")), NOW, t), json!({"ok": true, "name": "gpu"}));
        let j = joins_with(json!([{"id": "a", "codeHash": h, "expiresAt": NOW + 1}]));
        for bad in [Some(b"not json".to_vec()), Some(br#"{"hostname":"x"}"#.to_vec()), Some(line("ABCDEFGHJKLN")), None] {
            assert_eq!(j.check(peer(2), bad.as_deref(), NOW, t)["error"], "invalid_code");
        }
        assert!(j.pending(NOW));
    }

    #[test]
    fn five_failures_stop_a_peer_and_thirty_stop_everyone_for_ten_minutes() {
        let h = hex(&code_hash("ABCDEFGHJKLM"));
        let j = joins_with(json!([{"id": "a", "codeHash": h, "expiresAt": u64::MAX}]));
        let t = Instant::now();
        for _ in 0..5 {
            assert_eq!(j.check(peer(1), Some(&line("ZZZZZZZZZZZZ")), NOW, t)["error"], "invalid_code");
        }
        // Over the limit nothing is checked, not even a right code.
        assert_eq!(j.check(peer(1), Some(&line("ABCDEFGHJKLM")), NOW, t)["error"], "rate_limited");
        assert!(j.pending(NOW));
        // Another peer is not limited by it.
        for n in 2..=7 {
            for _ in 0..4 {
                j.check(peer(n), Some(&line("ZZZZZZZZZZZZ")), NOW, t);
            }
        }
        // 5 + 6 * 4 = 29 failures; one more reaches 30.
        assert_eq!(j.check(peer(8), Some(&line("ZZZZZZZZZZZZ")), NOW, t)["error"], "invalid_code");
        assert_eq!(j.check(peer(9), Some(&line("ABCDEFGHJKLM")), NOW, t)["error"], "rate_limited");
        // Ten minutes later both limits are clear.
        let later = t + WINDOW;
        assert_eq!(j.check(peer(1), Some(&line("ABCDEFGHJKLM")), NOW, later), json!({"ok": true, "name": "box"}));
        assert!(j.lock().peer_fails.is_empty());
    }

    #[test]
    fn a_join_keeps_where_the_machine_came_from_then_what_it_named() {
        let h = hex(&code_hash("ABCDEFGHJKLM"));
        let j = joins_with(json!([{"id": "a", "codeHash": h, "expiresAt": NOW + 1}]));
        let seen: SocketAddr = "192.168.1.7:41000".parse().unwrap();
        let mut named: Vec<String> = vec!["192.168.1.7:41000".into(), "nope".into(), "[fd00::7]:41000".into()];
        named.extend((1..=10).map(|n| format!("10.0.0.{n}:1")));
        let req = json!({"code": "ABCDEFGHJKLM", "hostname": "box", "platform": "linux-x64", "addrs": named}).to_string().into_bytes();
        assert_eq!(j.check_from(peer(1), Some(&req), &[seen], NOW, Instant::now())["ok"], true);
        let addrs = j.status()[0]["used"]["addrs"].clone();
        assert_eq!(addrs[0], "192.168.1.7:41000");
        assert_eq!(addrs[1], "[fd00::7]:41000");
        assert_eq!(addrs.as_array().unwrap().len(), MAX_ADDRS);
    }

    #[test]
    fn a_bad_invite_list_is_refused_whole() {
        let h = hex(&code_hash("ABCDEFGHJKLM"));
        let j = joins_with(json!([{"id": "a", "codeHash": h, "expiresAt": NOW + 1}]));
        for bad in [
            json!(null),
            json!([{"codeHash": h, "expiresAt": 1}]),
            json!([{"id": "b", "codeHash": "abc", "expiresAt": 1}]),
            json!([{"id": "b", "codeHash": h, "expiresAt": "soon"}]),
            json!([{"id": "b", "codeHash": h, "expiresAt": 1, "name": 3}]),
            json!([{"id": "b", "codeHash": h, "expiresAt": 1}, {"id": "b", "codeHash": h, "expiresAt": 1}]),
        ] {
            assert!(j.set(&bad).is_err(), "{bad}");
        }
        assert_eq!(j.status()[0]["id"], "a");
        assert!(j.pending(NOW));
    }
}
