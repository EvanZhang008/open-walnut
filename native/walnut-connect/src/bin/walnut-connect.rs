//! Walnut Connect as a command: what the app runs, on a computer, for the end-to-end tests.
//!
//!   walnut-connect run --config FILE   prints {"event":"ready","port","id"}, then serves until
//!                                      stdin closes (or SIGTERM); the config is client.rs Config
//!   walnut-connect id --key HEX        prints {"id"}: the endpoint id the Mac lists for that key
//!   walnut-connect status              (inside run: not available; the app reads wc_status)

use std::io::Write;

fn usage() -> ! {
    eprintln!("usage: walnut-connect run --config FILE | id --key HEX | --version");
    std::process::exit(2)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") => println!("walnut-connect {}", walnut_connect::VERSION),
        Some("id") => {
            let key = flag(&args, "--key").unwrap_or_else(|| usage());
            match walnut_connect::client::endpoint_id(&key) {
                Ok(id) => println!("{}", serde_json::json!({"id": id})),
                Err(e) => {
                    eprintln!("{e:#}");
                    std::process::exit(1)
                }
            }
        }
        Some("run") => {
            let file = flag(&args, "--config").unwrap_or_else(|| usage());
            let text = std::fs::read_to_string(&file).unwrap_or_else(|e| {
                eprintln!("read {file}: {e}");
                std::process::exit(1)
            });
            let started = walnut_connect::start(&text);
            if started["ok"] != true {
                eprintln!("{started}");
                std::process::exit(1)
            }
            {
                let mut out = std::io::stdout().lock();
                let _ = writeln!(out, "{}", serde_json::json!({"event": "ready", "port": started["port"], "id": started["id"]}));
                let _ = out.flush();
            }
            // Status lines on request: one line on stdin ("status") answers one line out.
            let stdin = std::io::stdin();
            let mut line = String::new();
            while stdin.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                let v = match line.trim() {
                    "status" => walnut_connect::status(),
                    "connect" => walnut_connect::connect(),
                    "network" => {
                        walnut_connect::network_changed();
                        serde_json::json!({"ok": true})
                    }
                    _ => serde_json::json!({"ok": false, "error": "status | connect | network"}),
                };
                let mut out = std::io::stdout().lock();
                let _ = writeln!(out, "{v}");
                let _ = out.flush();
                line.clear();
            }
            walnut_connect::stop();
        }
        _ => usage(),
    }
}
