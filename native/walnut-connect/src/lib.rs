//! Walnut Connect for the Walnut app (include/walnut_connect.h is the C side).
//!
//! The phone reaches the user's own Walnut (the Mac's walnut-net, native/walnut-net/src/web.rs)
//! over iroh: QUIC with the two machines' keys, end to end encrypted, direct when the two see
//! each other, else through a relay that passes on bytes it cannot read. The app gets a
//! 127.0.0.1 port and uses it as one more route to its Walnut (client.rs).
//!
//! Every function takes and returns JSON text, runs on a runtime of its own (never the caller's
//! thread past a short wait), and never unwinds into the caller: a panic is caught and answered
//! as `{"ok":false,"error":...}`. Strings this library returns are freed with `wc_free`.

pub mod client;

use std::ffi::{CStr, CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};

use client::{Client, Config};

/// The library's version (the app logs it; the server never sees it).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("walnut-connect")
            .enable_all()
            .build()
            .expect("a runtime for Walnut Connect")
    })
}

static CLIENT: Mutex<Option<Arc<Client>>> = Mutex::new(None);

fn current() -> Option<Arc<Client>> {
    CLIENT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Start the connector on `config` (client.rs Config), replacing one that runs. A start with
/// the same config as the running one keeps it (and its port).
pub fn start(config: &str) -> Value {
    let cfg = match Config::parse(config) {
        Ok(c) => c,
        Err(e) => return json!({"ok": false, "error": format!("{e:#}")}),
    };
    let rt = runtime();
    if let Some(c) = current() {
        if c.same_config(&cfg) {
            return json!({"ok": true, "port": c.port, "id": c.ep.id().to_string(), "kept": true});
        }
        rt.block_on(c.stop());
        *CLIENT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    match rt.block_on(async { tokio::time::timeout(Duration::from_secs(15), Client::start(cfg)).await }) {
        Ok(Ok(c)) => {
            let out = json!({"ok": true, "port": c.port, "id": c.ep.id().to_string()});
            *CLIENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(c);
            out
        }
        Ok(Err(e)) => json!({"ok": false, "error": format!("{e:#}")}),
        Err(_) => json!({"ok": false, "error": "starting Walnut Connect took over 15 s"}),
    }
}

pub fn status() -> Value {
    match current() {
        Some(c) => {
            let mut v = runtime().block_on(c.status());
            v["ok"] = json!(true);
            v["version"] = json!(VERSION);
            v
        }
        None => json!({"ok": true, "running": false, "version": VERSION}),
    }
}

/// Dial now (when no connection is up) and say how the link goes: the app's "Check now".
pub fn connect() -> Value {
    let Some(c) = current() else { return json!({"ok": false, "error": "Walnut Connect is not running"}) };
    match runtime().block_on(c.connection()) {
        Ok(_) => {
            let mut v = runtime().block_on(c.status());
            v["ok"] = json!(true);
            v
        }
        Err(e) => json!({"ok": false, "error": format!("{e:#}")}),
    }
}

pub fn network_changed() {
    if let Some(c) = current() {
        // Not waited for: the caller is the app's network monitor.
        runtime().spawn(async move { c.network_changed().await });
    }
}

pub fn stop() {
    let c = CLIENT.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(c) = c {
        runtime().block_on(c.stop());
    }
}

fn answer(f: impl FnOnce() -> Value) -> *mut c_char {
    let v = catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|p| {
        let msg = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default();
        json!({"ok": false, "error": format!("Walnut Connect failed inside: {msg}")})
    });
    CString::new(v.to_string()).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

/// # Safety
/// `s` is null or a NUL-terminated string.
unsafe fn arg(s: *const c_char) -> String {
    if s.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned()
}

/// # Safety
/// `config_json` is null or a NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wc_start(config_json: *const c_char) -> *mut c_char {
    let cfg = unsafe { arg(config_json) };
    answer(|| start(&cfg))
}

#[unsafe(no_mangle)]
pub extern "C" fn wc_status() -> *mut c_char {
    answer(status)
}

#[unsafe(no_mangle)]
pub extern "C" fn wc_connect() -> *mut c_char {
    answer(connect)
}

#[unsafe(no_mangle)]
pub extern "C" fn wc_network_changed() {
    let _ = catch_unwind(network_changed);
}

#[unsafe(no_mangle)]
pub extern "C" fn wc_stop() {
    let _ = catch_unwind(stop);
}

/// # Safety
/// `key_hex` is null or a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wc_endpoint_id(key_hex: *const c_char) -> *mut c_char {
    let key = unsafe { arg(key_hex) };
    answer(|| match client::endpoint_id(&key) {
        Ok(id) => json!({"ok": true, "id": id}),
        Err(e) => json!({"ok": false, "error": format!("{e:#}")}),
    })
}

/// # Safety
/// `s` is null or a string this library returned, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wc_free(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { CString::from_raw(s) });
    }
}
