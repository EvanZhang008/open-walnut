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

## Pairing

On first run enter the server URL and a device token (from `walnut device add`),
or copy a `wn://pair?name=..&token=..` link and tap "Paste pairing link".
