//! walnut-net: Walnut's host network connector. One runs on each of the user's machines that joined
//! the network, started and watched by that machine's Walnut daemon.
//!
//! It holds this machine's network identity (an Ed25519 key; the endpoint id is its public key) and
//! carries Walnut daemon links between the user's own machines over iroh: direct when the two can
//! reach each other, else through a relay. `relayMode` in the config picks which: `custom` (the
//! user's own relays, no third-party server is contacted), `public` (iroh's public relays and its
//! pkarr/DNS address lookup, which publishes only the relay, never an IP address) or `none`
//! (direct only). Router port mapping is off in every mode.
//!
//!   walnut-net id --key FILE                       print {"id"} (makes the key, 0600, on first use)
//!   walnut-net run --config FILE [--exit-on-stdin-eof]
//!   walnut-net --version
//!
//! An incoming daemon connection is closed before any stream unless its id (proven by the TLS
//! handshake) is a member allowed to reach this daemon (`accept: true` in the config). Each accepted
//! stream is piped to this machine's daemon on 127.0.0.1. A join connection (join.rs) is answered
//! from any peer, only while an invite is pending. See control.rs for the control socket.

mod config;
mod control;
mod invites;
mod join;
#[cfg(test)]
mod join_tests;
mod log;
mod node;

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use serde_json::json;
use tokio::sync::mpsc;

use config::{Config, load_or_make_key};
use control::Event;
use node::Node;

/// Bumped when the control socket or the config changes shape (2: relayMode, invites, join).
const PROTOCOL: u32 = 2;
/// Exit code asking the supervisor to start this again (the config changed what the endpoint is).
const EXIT_RESTART: i32 = 75;
/// Exit code saying the config cannot be read (EX_CONFIG): the supervisor puts back the last one that worked.
const EXIT_CONFIG: i32 = 78;

fn usage() -> ! {
    eprintln!("usage: walnut-net id --key FILE | run --config FILE [--exit-on-stdin-eof] | --version");
    std::process::exit(2)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") | Some("version") => {
            println!("walnut-net {} (protocol {PROTOCOL}, iroh 1.4.1)", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("id") => {
            let key = flag(&args, "--key").unwrap_or_else(|| usage());
            let k = load_or_make_key(&PathBuf::from(key))?;
            println!("{}", json!({"id": k.public().to_string()}));
            Ok(())
        }
        Some("run") => {
            let cfg = PathBuf::from(flag(&args, "--config").unwrap_or_else(|| usage()));
            let stdin_eof = args.iter().any(|a| a == "--exit-on-stdin-eof");
            if std::env::var_os("RUST_LOG").is_some() {
                let _ = tracing_subscriber::fmt().with_writer(std::io::stderr).with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).try_init();
            }
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
            let code = rt.block_on(run(cfg, stdin_eof))?;
            rt.shutdown_timeout(std::time::Duration::from_secs(2));
            std::process::exit(code)
        }
        _ => usage(),
    }
}

async fn run(cfg_path: PathBuf, stdin_eof: bool) -> Result<i32> {
    let mut cfg = match Config::read(&cfg_path) {
        Ok(c) => c,
        Err(e) => {
            log::warn("config refused", json!({"error": format!("{e:#}")}));
            return Ok(EXIT_CONFIG);
        }
    };
    let listener = control::bind(&cfg.control).await.context("control socket")?;
    let node = Node::bind(&cfg).await?;
    let (tx, mut rx) = mpsc::channel::<Event>(8);
    tokio::spawn(node.clone().serve());
    tokio::spawn(control::serve(listener, node.clone(), tx.clone()));
    // Not println!: with panic=abort, a closed stdout (the daemon went away) would end the process.
    {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{}", json!({"event": "ready", "id": node.ep.id().to_string(), "control": cfg.control, "protocol": PROTOCOL}));
        let _ = out.flush();
    }
    log::info("walnut-net ready", json!({"id": node.ep.id().to_string(), "members": cfg.members.len(), "relayMode": cfg.relay_choice().as_str(), "relays": cfg.relays}));

    let (stop_tx, mut stop_rx) = mpsc::channel::<&'static str>(4);
    if stdin_eof {
        let stop = stop_tx.clone();
        tokio::spawn(async move {
            let mut sink = vec![0u8; 1024];
            let mut stdin = tokio::io::stdin();
            loop {
                match tokio::io::AsyncReadExt::read(&mut stdin, &mut sink).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            let _ = stop.send("stdin closed (the daemon is gone)").await;
        });
    }
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate())?;
        let mut int = signal(SignalKind::interrupt())?;
        let mut hup = signal(SignalKind::hangup())?;
        let stop = stop_tx.clone();
        let reload = tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = term.recv() => { let _ = stop.send("SIGTERM").await; }
                    _ = int.recv() => { let _ = stop.send("SIGINT").await; }
                    _ = hup.recv() => {
                        let (otx, _orx) = tokio::sync::oneshot::channel();
                        let _ = reload.send(Event::Reload(otx)).await;
                    }
                }
            }
        });
    }

    let code = loop {
        tokio::select! {
            why = stop_rx.recv() => {
                log::info("stopping", json!({"why": why}));
                break 0;
            }
            ev = rx.recv() => match ev {
                Some(Event::Reload(reply)) => {
                    let next = Config::read(&cfg_path);
                    match next {
                        Err(e) => { let _ = reply.send(Err(e)); }
                        Ok(next) if !next.same_endpoint(&cfg) => {
                            // Key, relay mode, relays or roots changed: the supervisor starts a new one.
                            let _ = reply.send(Ok(true));
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            break EXIT_RESTART;
                        }
                        Ok(next) => {
                            let r = node.set_members(&next).await;
                            if r.is_ok() { cfg = next; }
                            let _ = reply.send(r.map(|_| false));
                        }
                    }
                }
                None => bail!("control channel closed"),
            }
        }
    };
    let _ = std::fs::remove_file(&cfg.control);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), node.ep.close()).await;
    Ok(code)
}
