//! One JSON line per event on stderr; the daemon keeps it in its own log.

use serde_json::{Value, json};

fn emit(level: &str, msg: &str, fields: Value) {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let mut line = json!({"ts": ts as u64, "level": level, "msg": msg});
    if let (Some(obj), Value::Object(extra)) = (line.as_object_mut(), fields) {
        for (k, v) in extra {
            obj.insert(k, v);
        }
    }
    // Not eprintln!: with panic=abort, a closed stderr would end the process.
    use std::io::Write;
    let _ = writeln!(std::io::stderr().lock(), "{line}");
}

pub fn info(msg: &str, fields: Value) {
    emit("info", msg, fields)
}

pub fn warn(msg: &str, fields: Value) {
    emit("warn", msg, fields)
}

pub fn debug(msg: &str, fields: Value) {
    if std::env::var_os("WALNUT_NET_DEBUG").is_some() {
        emit("debug", msg, fields)
    }
}
