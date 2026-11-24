# Walnut Connect

Walnut Connect lets the iOS app reach the user's own Walnut (the Mac, the leader) from
anywhere, with no cloud companion, no Tailscale and no port opened on the router. The phone
talks to the Mac itself, end to end encrypted; nothing in between stores or reads the data.
It is the experiment `walnut_connect` (Settings > Experimental), off by default.

Setup is the same two steps as before: install Walnut on the Mac, then scan its pairing QR
with the phone. A QR made while Walnut Connect runs carries what the phone needs, so the
phone works away from the Mac's Wi-Fi from the first minute.

## The parts

```
iPhone app ── URLSession ──▶ 127.0.0.1:<port> in the app (native/walnut-connect, Rust, iroh)
                                   │  QUIC, ALPN walnut/web/1, the phone's own key
                                   ▼  (direct when a hole punch works, else through a relay)
Mac: walnut-net (native/walnut-net) lets in listed phone ids only
                                   │  one unix socket stream per QUIC stream
                                   ▼
Mac: the connect door (src/web/connect-door.ts), the same Walnut server app
     on a unix socket: every request needs the phone's device token
```

- **The phone library** (`native/walnut-connect`, iroh 1.5): holds an iroh endpoint with the
  phone's own Ed25519 key (the Keychain, this device only) and listens on a port of
  127.0.0.1 inside the app. Every TCP connection there becomes a stream to the Mac. To the
  app this is one more address of its Walnut (route kind `connect`), so every request, SSE
  stream, image load and route probe works through it unchanged.
- **walnut-net on the Mac** (the host network's binary, protocol 3): accepts the ALPN
  `walnut/web/1` only from the phones on its list (`phones` in its config) and pipes each
  stream into the door (`webSocket`). A machine of the host network on this ALPN, or a
  phone on the daemon's ALPN, is refused before any stream (closed with 403). Removing a
  phone closes its open connections (410); a newer connection of the same phone replaces
  the older one (409). The phone reads 403 and 410 as "not paired any more" and waits 30
  seconds before it dials again.
- **The door** (`src/web/connect-door.ts`): a second listener of the same server app on a
  unix socket in a 0700 folder under the data home (`local/connect/door.sock`). A unix
  socket has no remote address, so `local-trust.ts` never treats it as this machine: every
  request needs a device token, exactly as on the Wi-Fi. WebSocket upgrades go to the main
  server's handler.

## Pairing and the route

- `POST /api/devices` (the console's Pair phone) mints a key for the new phone while Walnut
  Connect runs, puts its network id on the pairing's record in `auth.json`, and adds
  `&connect=<base64url JSON {k, id, m, r, i}>` to the QR: the key, the Mac's network id, its
  relay mode, its relays and its instance id. An older app ignores the parameter.
- `GET /api/v1/routes` lists the `connect` route (origin `walnut-connect://<Mac id>`, the
  peer as `connect: { id, relayMode, relays, relayRoots?, addrs }`) and `connectEndpoint`,
  the network id the caller's pairing has. A phone paired before Walnut Connect registers
  its own with `POST /api/v1/connect/register { endpoint }` (its device token only).
- The app stores the route with its own port as the origin
  (`AppConfig.localizedConnectRoutes`) and ranks it below Wi-Fi and Tailscale and above the
  companion: at home the Wi-Fi wins, away the Mac itself beats the companion's copy.
  Connect routes are stored under their own key (`walnut.routes.connect`), so an older
  build, which knows no `connect` kind, still reads every other route. When the Mac's own
  list no longer has the route (the experiment off), the phone drops it; a companion's copy
  of the list never does.
- The QR's key becomes the phone's only once that pairing worked, so a failed pairing leaves
  the phone's Walnut Connect to the Mac it had as it was.
- A revoke or re-pair takes the phone off walnut-net's list at once (the next host network
  sync, debounced one second; a sync already running is followed by a fresh one).
- Walnut Connect runs only while the host network is on: turning the network off closes
  the door, and nothing in Walnut Connect turns it back on. Switching the experiment on turns
  the network on, once.

## Relays

The phone uses the Mac's relay choice for the host network ([Host network, "Choosing the
relay"](./host-network.md)). With no companion that is iroh's public relays: they forward
encrypted packets they cannot read, and the two sides move to a direct path when a hole
punch works. The route names the relay the Mac is on, so the phone needs no lookup to find
it. With a companion that runs its own relay (relay mode `own`), the phone uses that relay
instead, so Walnut Connect then needs the companion's relay running; relay mode `public`
takes the companion out of the path entirely.

## What keeps strangers out

- Only a phone id on walnut-net's list gets a stream, and the list is the paired phones
  that have an id (`connectPhones` in `src/core/connect/connect-phones.ts`). One id belongs
  to one pairing (`409 endpoint_taken`).
- Every request through the door still needs that phone's device token: a stolen key
  without the token gets `401`, and a revoked pairing loses both.
- The phone's local port listens on 127.0.0.1 only and accepts loopback peers only. Another
  app on the phone could reach it, and would get only what a stranger on the Wi-Fi gets:
  `GET /api/v1/instance`, nothing behind a token. It can hold at most 60 streams open.
- The other way round matters more: the app sends its device token to that port, and another
  app could listen on a port the app does not hold (before the connector starts, after iOS
  takes a suspended app's listener away, Apple TN2277, or after the connector had to move to
  another port). So the token goes there only while the library reports, at that moment, that
  it holds exactly that port (`wc_listening`):
  - `WalnutConnectGuard` (a URLProtocol every URLSession configuration gets through
    `DemoMode.configured`, and `URLSession.shared` globally) fails any request to a Walnut
    Connect port, the ones used before included, that the library does not hold, and starts
    the connector;
  - the loads outside URLSession (AVPlayer with the token header, the HTML preview's web
    view) ask `WalnutConnect.maySend(to:)` first;
  - the app takes the listener again (`wc_rebind`, never waiting on a start under way) as it
    comes to the foreground, and in the background before a send once a second has passed,
    since iOS gives no notice when it suspends the app;
  - `tests/ios/walnut-connect-port-guard.test.ts` fails on a new URLSession that skips the
    hook, a background session, or a new load outside URLSession without the check.

## Limits

- The Mac must be awake and online. Leader switching (another Walnut answering while the Mac
  is off) is not part of Walnut Connect yet; the companion still covers a sleeping Mac.
- iroh's public relays are a free service run by its makers, with their own rate limits.
- A route selection waits for its slowest probe, and the Walnut Connect probe takes up to 9
  seconds (3 to start the connector, 6 to reach the Mac). Leaving home with the Mac asleep,
  the switch to the companion comes that much later.
- The release builds the real library or fails: `build-apple.sh` refuses the stub for a
  device Release build (and for any build with `WALNUT_CONNECT_REQUIRE=1`).
- The app is built with the real library only when Rust and its iOS targets are installed
  (`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`); otherwise
  `native/walnut-connect/build-apple.sh` builds a stub, and that build lists no Walnut
  Connect route.
- Walnut Connect needs walnut-net 0.3.0 (protocol 3) on the Mac and a daemon with
  `net-web-v1`. An older one is simply not offered the phones; the route stays out of
  `/routes` until walnut-net reports protocol 3.

## Checking it live

An isolated run on a dev box, no companion and no production data:

1. `walnut-dev run --bg srv -e WALNUT_NET_ACTIVE=1 -e WALNUT_NET_BIN=<walnut-net 0.3.0> bun run dev:ephemeral`
2. Inside it: `PUT /api/config {"experimental":{"walnut_connect":true}}`, then
   `POST /api/devices {"name":"test-phone"}`; its `pairingURI` carries `&connect=`.
3. Play the phone: `walnut-connect run --config phone.json` (the CLI of the same library,
   `{key, peer: {id, relays}, relayMode, port}` from the QR), then
   `curl 127.0.0.1:<port>/api/v1/status` answers 401, and 200 with the token.
4. The app: `WalnutConnectLiveUITests` pairs through the setup form with the link in
   `/tmp/walnut-connect-live.json` on the Mac (`{link, port, task}`) and loads the board.

## Where the code lives

- `native/walnut-connect/`: the phone library (`src/client.rs`, `src/lib.rs` C ABI,
  `include/`, `stub/`, `build-apple.sh`) and its CLI (`src/bin/walnut-connect.rs`)
- `native/walnut-net/src/web.rs`: the phones' ALPN on the Mac; `config.rs` `phones`, `webSocket`
- `src/core/connect/connect-net.ts`: when it runs, the route, the walnut-net fields
- `src/core/connect/connect-phones.ts`: phone ids on the device records, the key the QR carries
- `src/web/connect-door.ts`: the door; `src/web/routes/instance-routes-v1.ts`: `/routes`,
  `/connect/register`; `src/web/routes/devices.ts`: the QR parameter
- `ios-native/Walnut/Core/WalnutConnect.swift`: the app side of the library;
  `WalnutConnectGuard.swift`: the URLProtocol that holds the token back;
  `ServerRoute.swift`, `AppConfig.swift`, `ConnectionStore.swift`, `RouteCoordinator.swift`
- Tests: `tests/core/connect/`, `tests/web/routes/connect-door.test.ts`,
  `tests/ios/walnut-connect-port-guard.test.ts`, `native/walnut-connect` (`cargo test`),
  `native/walnut-net/src/web_tests.rs`, `ios-native/WalnutTests/WalnutConnectTests.swift`,
  `ios-native/WalnutUITests/WalnutConnectLiveUITests.swift`
