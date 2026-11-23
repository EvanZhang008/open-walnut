//! The connector's config file (JSON, written by the host's daemon) and its key file.

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use iroh::{EndpointId, RelayUrl, SecretKey};
use serde::Deserialize;

/// The config version this build reads.
pub const CONFIG_VERSION: u32 = 1;

/// Which relays the endpoint uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelayChoice {
    /// The user's own relays (`relays`), no address lookup.
    Custom,
    /// iroh's public relays and address lookup.
    Public,
    /// No relay and no lookup: direct paths only.
    None,
}

impl RelayChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            RelayChoice::Custom => "custom",
            RelayChoice::Public => "public",
            RelayChoice::None => "none",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    /// This host's secret key: 32 raw bytes, mode 0600 (made by `walnut-net id`).
    pub key: PathBuf,
    /// Absent: `custom` when `relays` is set, else `none` (how a v1 config always read).
    #[serde(default)]
    pub relay_mode: Option<RelayChoice>,
    /// The user's own relays (https URLs). Empty: direct paths only.
    #[serde(default)]
    pub relays: Vec<String>,
    /// Extra trust roots (PEM) for the relays' address-discovery listener, which has a
    /// certificate of its own that only the user's machines trust. The relays' HTTPS still
    /// checks against the public roots.
    #[serde(default)]
    pub relay_roots: Vec<String>,
    /// The user's machines this host talks to.
    #[serde(default)]
    pub members: Vec<Member>,
    /// The file holding this host's daemon port (one number). Each accepted stream connects
    /// to 127.0.0.1 on the port it holds at that moment.
    pub daemon_port_file: PathBuf,
    /// The control socket (a unix socket, mode 0600).
    pub control: PathBuf,
    /// UDP port to bind (0 or absent: any free port).
    #[serde(default)]
    pub bind_port: Option<u16>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// Its endpoint id (hex), which is its public key.
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// May it open a stream to this host's daemon? Only the machines that drive this
    /// daemon (the Mac, the cloud companion) may; every other member is closed before any stream.
    #[serde(default)]
    pub accept: bool,
    /// Known direct addresses (ip:port), optional: the relay finds the rest.
    #[serde(default)]
    pub addrs: Vec<String>,
    /// Relays it was last seen on (https URLs), optional: a machine that has not moved to
    /// this host's relay choice yet is still reached there.
    #[serde(default)]
    pub relays: Vec<String>,
}

impl Config {
    pub fn read(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path).with_context(|| format!("read config {}", path.display()))?;
        let cfg: Config = serde_json::from_str(&raw).with_context(|| format!("parse config {}", path.display()))?;
        if cfg.version != CONFIG_VERSION {
            bail!("config version {} is not {CONFIG_VERSION}: this walnut-net is older or newer than the daemon that wrote it", cfg.version);
        }
        cfg.check_relay_mode()?;
        cfg.relay_urls()?;
        // Checked here, not first in Node::bind: a reload that would rebuild the endpoint on
        // roots it cannot read is refused while the running one keeps going.
        cfg.root_certs()?;
        Ok(cfg)
    }

    pub fn relay_choice(&self) -> RelayChoice {
        self.relay_mode.unwrap_or(if self.relays.is_empty() { RelayChoice::None } else { RelayChoice::Custom })
    }

    fn check_relay_mode(&self) -> Result<()> {
        match self.relay_choice() {
            RelayChoice::Custom => {}
            RelayChoice::Public if !self.relays.is_empty() || !self.relay_roots.is_empty() => {
                bail!("relayMode public takes no relays or relayRoots")
            }
            RelayChoice::None if !self.relays.is_empty() => bail!("relayMode none takes no relays"),
            RelayChoice::Public | RelayChoice::None => {}
        }
        Ok(())
    }

    pub fn relay_urls(&self) -> Result<Vec<RelayUrl>> {
        self.relays.iter().map(|u| parse_relay_url(u)).collect()
    }

    /// The members this build can use. One it cannot (an id that is not a key, an address
    /// that is not a socket address) is left out and logged, never the whole list: a bad
    /// entry from one join must not cut every other machine off.
    pub fn member_map(&self) -> HashMap<EndpointId, Member> {
        let mut out = HashMap::new();
        for m in &self.members {
            let id: EndpointId = match m.id.parse() {
                Ok(id) => id,
                Err(e) => {
                    crate::log::warn("member left out: its id is not a key", serde_json::json!({"name": m.name, "id": m.id, "error": e.to_string()}));
                    continue;
                }
            };
            if let Some(a) = m.addrs.iter().find(|a| a.parse::<std::net::SocketAddr>().is_err()) {
                crate::log::warn("member left out: an address is not ip:port", serde_json::json!({"name": m.name, "address": a}));
                continue;
            }
            if let Some(r) = m.relays.iter().find(|r| parse_relay_url(r).is_err()) {
                crate::log::warn("member left out: a relay is not a relay URL", serde_json::json!({"name": m.name, "relay": r}));
                continue;
            }
            out.insert(id, m.clone());
        }
        out
    }

    pub fn root_certs(&self) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>> {
        use rustls::pki_types::{CertificateDer, pem::PemObject};
        let mut out = vec![];
        for pem in &self.relay_roots {
            for c in CertificateDer::pem_slice_iter(pem.as_bytes()) {
                out.push(c.context("relay root certificate")?);
            }
        }
        Ok(out)
    }

    /// What can change without a restart: the members. Anything else needs a new endpoint.
    pub fn same_endpoint(&self, other: &Config) -> bool {
        self.key == other.key
            && self.relay_choice() == other.relay_choice()
            && self.relays == other.relays
            && self.relay_roots == other.relay_roots
            && self.bind_port == other.bind_port
            && self.control == other.control
    }
}

/// A relay URL this build will use: https only, unless a test allows plain http.
pub fn parse_relay_url(u: &str) -> Result<RelayUrl> {
    let url: RelayUrl = u.parse().with_context(|| format!("relay URL {u}"))?;
    if url.scheme() != "https" && !cfg!(debug_assertions) && std::env::var_os("WALNUT_NET_ALLOW_HTTP_RELAY").is_none() {
        bail!("relay {u} is not https");
    }
    Ok(url)
}

/// This host's key: made on first use (0600, never replaced), read after.
pub fn load_or_make_key(path: &Path) -> Result<SecretKey> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let meta = std::fs::metadata(path)?;
            if meta.permissions().mode() & 0o077 != 0 {
                // Readable by others: tighten it, as ssh would insist on.
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            }
            let b: [u8; 32] = bytes.try_into().map_err(|_| anyhow!("{}: not a walnut-net key (32 bytes)", path.display()))?;
            Ok(SecretKey::from_bytes(&b))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let b: [u8; 32] = rand::random();
            // Written whole under another name, then linked in: a crash never leaves a short key,
            // and of two first runs at once one key wins and both read it.
            let tmp: PathBuf = path.with_extension(format!("tmp-{}", std::process::id()));
            {
                let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
                f.write_all(&b)?;
                f.sync_all()?;
            }
            let linked = std::fs::hard_link(&tmp, path);
            let _ = std::fs::remove_file(&tmp);
            match linked {
                Ok(()) => Ok(SecretKey::from_bytes(&b)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => load_or_make_key(path),
                Err(e) => Err(e.into()),
            }
        }
        Err(e) => Err(e).with_context(|| format!("read key {}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("walnut-net-cfg-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn key_is_made_once_and_kept() {
        let d = dir();
        let p = d.join("net.key");
        let a = load_or_make_key(&p).unwrap();
        let b = load_or_make_key(&p).unwrap();
        assert_eq!(a.public(), b.public());
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_short_key_file_is_refused_not_replaced() {
        let d = dir();
        let p = d.join("net.key");
        std::fs::write(&p, b"short").unwrap();
        assert!(load_or_make_key(&p).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"short");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_bad_member_is_left_out_not_the_list_and_other_versions_are_refused() {
        let d = dir();
        let p = d.join("c.json");
        let base = |members: &str, v: u32| format!(r#"{{"version":{v},"key":"k","daemonPortFile":"p","control":"c","members":{members}}}"#);
        std::fs::write(&p, base("[]", 2)).unwrap();
        assert!(Config::read(&p).is_err());
        let id = SecretKey::from_bytes(&[3u8; 32]).public().to_string();
        // 64 hex characters that are not a point on the curve: the shape a server checks, not a key.
        let not_a_key = (0u8..=255)
            .map(|b| hex_of(&[b; 32]))
            .find(|h| h.parse::<EndpointId>().is_err())
            .expect("some 32-byte pattern is not a key");
        let members = format!(
            r#"[{{"id":"nothex","accept":true}},{{"id":"{not_a_key}","name":"bad"}},{{"id":"{id}","name":"mac","accept":true}},{{"id":"{id}","name":"addr","addrs":["nope"]}},{{"id":"{id}","name":"relay","relays":["not a url"]}}]"#
        );
        std::fs::write(&p, base(&members, 1)).unwrap();
        let c = Config::read(&p).unwrap();
        let m = c.member_map();
        assert_eq!(m.len(), 1);
        assert_eq!(m.values().next().unwrap().name, "mac");
        assert!(m.values().next().unwrap().accept);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn unreadable_relay_roots_are_refused_at_read() {
        let d = dir();
        let p = d.join("c.json");
        let bad = "-----BEGIN CERTIFICATE-----\\nnot base64 !!\\n-----END CERTIFICATE-----\\n";
        std::fs::write(&p, format!(r#"{{"version":1,"key":"k","daemonPortFile":"p","control":"c","relayRoots":["{bad}"]}}"#)).unwrap();
        assert!(Config::read(&p).is_err());
        std::fs::remove_dir_all(d).unwrap();
    }

    /// A config with these extra fields, as Config::read takes it.
    fn read_with(extra: &str) -> Result<Config> {
        let d = dir();
        let p = d.join("c.json");
        std::fs::write(&p, format!(r#"{{"version":1,"key":"k","daemonPortFile":"p","control":"c"{extra}}}"#)).unwrap();
        let r = Config::read(&p);
        std::fs::remove_dir_all(d).unwrap();
        r
    }

    const RELAY: &str = r#","relays":["https://relay.example.test"]"#;

    #[test]
    fn relay_mode_defaults_from_relays_and_parses_each_choice() {
        assert_eq!(read_with("").unwrap().relay_choice(), RelayChoice::None);
        assert_eq!(read_with(RELAY).unwrap().relay_choice(), RelayChoice::Custom);
        assert_eq!(read_with(&format!(r#"{RELAY},"relayMode":"custom""#)).unwrap().relay_choice(), RelayChoice::Custom);
        assert_eq!(read_with(r#","relayMode":"public""#).unwrap().relay_choice(), RelayChoice::Public);
        assert_eq!(read_with(r#","relayMode":"none""#).unwrap().relay_choice(), RelayChoice::None);
        // Custom with no relays is today's no-relay endpoint, not an error.
        assert_eq!(read_with(r#","relayMode":"custom""#).unwrap().relay_choice(), RelayChoice::Custom);
        assert_eq!(RelayChoice::Public.as_str(), "public");
    }

    #[test]
    fn relay_mode_refuses_unknown_values_and_relays_it_cannot_use() {
        for bad in [r#","relayMode":"n0""#, r#","relayMode":"PUBLIC""#, r#","relayMode":"""#, r#","relayMode":1"#] {
            assert!(read_with(bad).is_err(), "{bad} should be refused");
        }
        assert!(read_with(&format!(r#"{RELAY},"relayMode":"public""#)).is_err());
        assert!(read_with(r#","relayMode":"public","relayRoots":["x"]"#).is_err());
        assert!(read_with(&format!(r#"{RELAY},"relayMode":"none""#)).is_err());
        // Null reads as absent.
        assert_eq!(read_with(r#","relayMode":null"#).unwrap().relay_choice(), RelayChoice::None);
    }

    #[test]
    fn same_endpoint_counts_the_relay_mode() {
        let none = read_with("").unwrap();
        let none_explicit = read_with(r#","relayMode":"none""#).unwrap();
        let public = read_with(r#","relayMode":"public""#).unwrap();
        let custom = read_with(RELAY).unwrap();
        let custom_explicit = read_with(&format!(r#"{RELAY},"relayMode":"custom""#)).unwrap();
        let custom_empty = read_with(r#","relayMode":"custom""#).unwrap();
        assert!(none.same_endpoint(&none_explicit));
        assert!(custom.same_endpoint(&custom_explicit));
        assert!(!none.same_endpoint(&public));
        assert!(!public.same_endpoint(&custom));
        // Same (empty) relays, other mode: still a new endpoint.
        assert!(!none.same_endpoint(&custom_empty));
        let members = read_with(r#","relayMode":"public","members":[{"id":"x"}]"#).unwrap();
        assert!(public.same_endpoint(&members));
    }

    fn hex_of(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
