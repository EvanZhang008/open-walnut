# Walnut iOS (native SwiftUI)

Native SwiftUI companion app for a Walnut server — chat with your butler,
browse and edit notes, all over the frozen
[`/api/v1` REST+SSE contract](../docs/reference/api-v1.md).

Replaces the Expo app in `../ios/` (kept as reference until this one is fully verified).

## Requirements

- Xcode 16+ (iOS 17 deployment target)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)

## Build

```bash
cd ios-native
xcodegen generate        # project.yml → Walnut.xcodeproj
xcodebuild -project Walnut.xcodeproj -scheme Walnut \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' build
```

Or open `Walnut.xcodeproj` in Xcode and run.

`Walnut.xcodeproj` is **generated output and not committed** (see `.gitignore`);
`project.yml` is the source of truth — rerun `xcodegen generate` after pulling.

## Architecture

```
Walnut/
  App/        WalnutApp (entry, setup gate, tab shell)
  API/        WalnutAPI (URLSession REST client) · SSEClient (streaming) · Models
  Core/       Theme · AppConfig (UserDefaults) · KeychainHelper (token) · DiskCache
  Stores/     @Observable ChatStore · NotesStore · ConnectionStore
  Views/      SwiftUI screens (Chat, Notes, Settings, Setup)
```

- **Auth**: device token in the Keychain; every request sends `Authorization: Bearer`.
  A 401 anywhere wipes config and returns to setup.
- **Streaming**: one SSE connection per open conversation; `Last-Event-ID` on
  reconnect with exponential backoff, `: ping` comments ignored.
- **Send flow**: POST message → 202 `{turnId}` → deltas arrive on the open
  stream; `409 turn_active` disables the composer until `message-end`.
- **Caching**: conversations / message tails / notes tree cached to disk
  (stale-while-revalidate — cached data renders instantly, refresh follows).
- **Notes**: optimistic locking via `expectedHash`; on 409 the user picks
  overwrite (last-write-wins) or reload.

## Flight recorder (field diagnostics)

TestFlight builds can't be attached to with a debugger, so the app records what
it does and ships it to **your own** server. The design goal is that after any
field incident the app's behavior is reconstructable minute-by-minute *without
asking the user anything*.

```
log call site                       AppLog.debug/info/warn/error
  │  (O(1): one struct under a lock, no I/O, no formatting)
  ▼
staged (memory)  ──5s timer / 64 lines──▶  LogSpill (disk JSONL + byte cursor)
                                              │  ~16 MB rolling, oldest-first
                                              │  eviction, drops COUNTED
                                              ▼
                          45s timer / 200 lines / error debounce (12s)
                          / connectivity recovery / foreground
                          / freeze + memory-warning (uploadCritical)
                          / Settings → "Send Diagnostics Now"
                                              │
                                              ▼
                            gzip (~9x) ─▶ POST /api/v1/client-logs
                                              │  cursor advances only on 2xx
                                              ▼
                    /tmp/open-walnut/ios-client/<device>-<day>.log
                                              │
                       subsystem=freeze|crash ─▶ bus client:incident
                                              ─▶ notification (console bell)
```

- **Full-dump is the default.** Every level (`debug` included) from every
  subsystem is retained and uploaded. Dial back with the `walnut.logLevel`
  UserDefaults key if ever needed.
- **Volume** (measured, realistic mix): ~194 B/line raw, ~9× gzip. A heavy 12 h
  day ≈ **2.3 MB** on the server, **~250 KB** on the wire. The 16 MB disk queue
  holds days of backlog, so a long offline stretch loses nothing.
- **Losing a line is hard, and an unavoidable loss is visible.** Uploads are
  acknowledged by byte cursor after a 2xx (a kill mid-flight re-sends, never
  drops), and cap eviction emits a `dropped lines` marker so a gap is labelled.
- **Automatic breadcrumbs, no per-call-site work.** `FreezeContext` crumbs
  (send, focus/blur, kb-show/hide with the 10 s flip count, turn-end, screen
  enter/leave) fan out to the log through a sink, and a 30 s heartbeat samples
  the whole freeze snapshot (screen, draft/history/live sizes, memory) with a
  quiet-collapse so an idle app doesn't pad the tape.
- **Main-thread-free end to end.** Append, flush, persist and upload all work
  while the main thread is FROZEN — that is what lets `MainThreadWatchdog`'s
  report escape a hang. Nothing on these paths may touch UIKit or the main queue
  (device identity and the `UIApplication` reference are cached at startup; see
  `BackgroundAssertion`).

Key files: `Core/AppLog.swift` (levels, batching, upload) ·
`Core/LogSpill.swift` (durable queue) · `Core/Breadcrumbs.swift` (heartbeat +
crumb sink) · `Core/FreezeContext.swift` (O(1) state snapshot) ·
`Core/MainThreadWatchdog.swift` (freeze detector) · `Core/CrashReporter.swift`
(MetricKit) · server: `src/core/notifications/client-incidents.ts`.

## Pairing

On first run enter the server URL and a device token (from `walnut device add`),
or copy a `wn://pair?name=..&token=..` link and tap "Paste pairing link".
