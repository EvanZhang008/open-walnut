# Walnut iOS (native SwiftUI)

Native SwiftUI companion app for a Walnut server. Chat with your Personal AI,
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

## Tests

```bash
cd ios-native
# unit + rendering-perf gates (no pairing needed)
xcodebuild test -project Walnut.xcodeproj -scheme Walnut \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -only-testing:WalnutTests

# the XCUITest layer — use the script, see the note below
tests/ui/run-ui-tests.sh
tests/ui/run-ui-tests.sh -only-testing:WalnutUITests/VoiceQuickActionUITests
```

Some UI tests need the app PAIRED, which they take from `WALNUT_UITEST_SERVER` /
`WALNUT_UITEST_TOKEN` and otherwise skip. Run them through
`tests/ui/run-ui-tests.sh`, and do not reach for a bare `xcodebuild`:
**xcodebuild does not pass your shell's environment to the XCUITest runner
process**, so `export WALNUT_UITEST_SERVER=…` skips every test, silently — which
is what these tests did on every machine until the script existed, and a
permanently-skipping test is indistinguishable from a deleted one. The runner
only ever sees variables written into the `.xctestrun`'s `EnvironmentVariables`.
`TEST_RUNNER_WALNUT_UITEST_SERVER=…` is the documented way to put one there, but
on Xcode 26 it did not land even when passed to `build-for-testing`, so the
script checks the `.xctestrun` with `plutil` and writes the variables in itself.
That check is the point: it fails loudly instead of skipping quietly.

The script pairs at a dead port by default, which touches no real data and is
enough for all three voice tests plus the three board geometry tests (the board
renders disk-cached rows offline). Pass a real `WALNUT_UITEST_SERVER` when you
want live content, and `WALNUT_UITEST_ROW_ID` for the board's tap test, which
needs a throwaway task the run owns.

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

## Voice Quick Action ("Voice to Walnut")

The fastest path from pocket to Personal AI: long-press the app icon, pick
**Voice to Walnut**, talk, stop. The transcript is sent to the main agent
immediately, with no draft review and no intent picker: the agent reads the
sentence and decides whether it's a search, a note, a task, or a chat.

```
long-press icon                       UIApplicationShortcutItems (Info.plist)
  │
  ▼
QuickActionDelegate                   cold: didFinishLaunchingWithOptions
  │  (UIKit; the only reason it exists)   warm: performActionFor
  ▼
VoiceQuickAction.shared               mailbox: pending request + autoSendArmed
  │  (2-minute TTL, one-shot consume)
  ├──▶ MainTabView                    brings the Chat tab forward
  ▼
ComposerBar (chat only)               switch to the main agent → voice.start()
  │
  ▼
stop ─▶ VoiceRecorder.stopAndTranscribe ─▶ ChatStore.send (the ordinary path)
```

- The mic only opens on a composer the user can SEE (a retained off-screen tab
  never records), and only while online: recording would work offline but the
  SEND wouldn't, and the shortcut's entire promise is that it reaches the agent.
- Auto-send is **one-shot**. Any interruption of the happy path (cancel, failed
  transcription, navigating away, a mic that wouldn't open) disarms it, so the
  preserved audio's later Retry lands in the draft for review instead of sending
  text the user never saw. Audio itself is preserved exactly as always: the
  no-loss contract in `VoiceRecorder` is untouched.
- The recording row's caption states the consequence: "Recording — stop to send"
  for a quick-action take, plain "Recording…" for an ordinary mic tap.

Tests: `WalnutTests/VoiceQuickActionTests.swift` (routing, TTL, one-shot arming,
Info.plist ↔ Swift constant pinning) and `tests/voice/voice-quickaction-e2e.sh`
(real app + real mic + isolated server; asserts the transcript arrives as a user
message on agent `general`).

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
