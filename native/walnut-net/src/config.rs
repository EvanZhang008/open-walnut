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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    /// This host's secret key: 32 raw bytes, mode 0600 (made by `walnut-net id`).
    pub key: PathBuf,
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
}

impl Config {
    pub fn read(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path).with_context(|| format!("read config {}", path.display()))?;
        let cfg: Config = serde_json::from_str(&raw).with_context(|| format!("parse config {}", path.display()))?;
        if cfg.version != CONFIG_VERSION {
            bail!("config version {} is not {CONFIG_VERSION}: this walnut-net is older or newer than the daemon that wrote it", cfg.version);
        }
        cfg.relay_urls()?;
        cfg.member_map()?;
        Ok(cfg)
    }

    pub fn relay_urls(&self) -> Result<Vec<RelayUrl>> {
        self.relays
            .iter()
            .map(|u| {
                let url: RelayUrl = u.parse().with_context(|| format!("relay URL {u}"))?;
                if url.scheme() != "https" && !cfg!(debug_assertions) && std::env::var_os("WALNUT_NET_ALLOW_HTTP_RELAY").is_none() {
                    bail!("relay {u} is not https");
                }
                Ok(url)
            })
            .collect()
    }

    pub fn member_map(&self) -> Result<HashMap<EndpointId, Member>> {
        let mut out = HashMap::new();
        for m in &self.members {
            let id: EndpointId = m.id.parse().map_err(|e| anyhow!("member {:?}: bad id {}: {e}", m.name, m.id))?;
            for a in &m.addrs {
                a.parse::<std::net::SocketAddr>().with_context(|| format!("member {:?}: address {a}", m.name))?;
            }
            out.insert(id, m.clone());
        }
        Ok(out)
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
            && self.relays == other.relays
            && self.relay_roots == other.relay_roots
            && self.bind_port == other.bind_port
            && self.control == other.control
    }
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
    fn config_rejects_bad_member_ids_and_other_versions() {
        let d = dir();
        let p = d.join("c.json");
        let base = |members: &str, v: u32| format!(r#"{{"version":{v},"key":"k","daemonPortFile":"p","control":"c","members":{members}}}"#);
        std::fs::write(&p, base(r#"[{"id":"nothex","accept":true}]"#, 1)).unwrap();
        assert!(Config::read(&p).is_err());
        std::fs::write(&p, base("[]", 2)).unwrap();
        assert!(Config::read(&p).is_err());
        let id = SecretKey::from_bytes(&[3u8; 32]).public().to_string();
        std::fs::write(&p, base(&format!(r#"[{{"id":"{id}","name":"mac","accept":true}}]"#), 1)).unwrap();
        let c = Config::read(&p).unwrap();
        assert!(c.member_map().unwrap().values().next().unwrap().accept);
        std::fs::remove_dir_all(d).unwrap();
    }
}
