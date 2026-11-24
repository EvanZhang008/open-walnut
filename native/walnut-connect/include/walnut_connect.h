// Walnut Connect: the C side of native/walnut-connect (src/lib.rs). The Walnut app links
// libwalnut_connect.a (build-apple.sh) and calls these through the WalnutConnectFFI module.
//
// Every call takes and returns JSON text. A returned string is the caller's to free with
// wc_free. The calls that return one block for a short while (wc_start up to 15 s, wc_connect
// up to a dial): never call them on the main thread.
#ifndef WALNUT_CONNECT_H
#define WALNUT_CONNECT_H

#ifdef __cplusplus
extern "C" {
#endif

// Start the connector, or keep the running one when the config names the same endpoint.
// config: {"key": hex64, "peer": {"id", "relays", "addrs"}, "relayMode", "relays", "relayRoots", "port"}
// Answer: {"ok": true, "port": N, "id": "<this phone's network id>"} or {"ok": false, "error"}.
// A build without the Rust library (the stub) answers {"ok": false, "stub": true, "error"}.
char *wc_start(const char *config_json);

// {"ok": true, "running", "id", "peer", "port", "link": {"path", "rttMs"} | null, "lastError", ...}
char *wc_status(void);

// Dial now when no connection is up, then the status; {"ok": false, "error"} when it cannot.
char *wc_connect(void);

// The port the connector's listener holds right now, 0 while none does (not running, lost,
// being rebound). Cheap: the app checks it before it sends anything to its port.
unsigned short wc_listening(void);
// Listen again, the same port while it is free: {"ok": true, "port": N, "moved": bool}. The
// app calls it when it comes back from the background (iOS reclaims a suspended app's listener).
// It never waits: during a start or stop it answers {"ok": false, "busy": true}.
char *wc_rebind(void);
// The network under the app changed (another Wi-Fi, cellular, back from the background).
void wc_network_changed(void);

// Stop the connector and close its port.
void wc_stop(void);

// {"ok": true, "id"}: the network id of a 64-hex secret key.
char *wc_endpoint_id(const char *key_hex);

void wc_free(char *s);

#ifdef __cplusplus
}
#endif

#endif
