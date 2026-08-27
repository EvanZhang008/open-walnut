# iOS Push Notifications (Human Inbox Letters)

Every letter an agent writes to the Human Inbox can notify your iPhone. The code
for this is complete and tested, but sending needs one credential that cannot be
created from inside this repo: an **APNs auth key** from your Apple developer
account. Until you add it, the server registers your phone, reports honestly that
it cannot deliver, and logs the reason. Nothing fails silently.

## The one thing you have to do

You need an **APNs auth key**. If you already ship this app to TestFlight you have
an *App Store Connect API key*, and it is a different credential: both are `.p8`
files, both are named `AuthKey_<ID>.p8`, and they are not interchangeable. An App
Store Connect key presented to APNs is rejected with `403 InvalidProviderToken`,
which looks exactly like a broken server.

| | App Store Connect API key | APNs auth key |
|---|---|---|
| Created in | App Store Connect: Users and Access, Integrations | developer.apple.com: Certificates, Identifiers & Profiles, Keys |
| Used for | Uploading builds, the ASC REST API | Signing pushes to `api.push.apple.com` |
| Identified by | key id **and an issuer id** | key id **and your team id** (no issuer id) |

### 1. Create the key

1. Go to developer.apple.com, Certificates, Identifiers & Profiles, **Keys**, then `+`.
2. Name it something like "Walnut APNs" and check **Apple Push Notifications service (APNs)**.
3. Register, then **Download**. Apple serves the file exactly once, so keep it.
4. Note the **Key ID**. Your **Team ID** is on the same portal, top right.

A team can hold at most two APNs keys, and creating one needs Account Holder or
Admin access.

### 2. Enable Push Notifications on the App ID

Same portal, **Identifiers**, pick the app's bundle id (`dev.openwalnut.ios`),
check **Push Notifications**, Save. Automatic signing then mints a provisioning
profile carrying `aps-environment`, which is what lets a device build register.
Without this step the app cannot mint a token at all, and Xcode fails to
provision a device build.

### 3. Point Walnut at the key

The private key never goes in `config.yaml`: config gets copied between machines,
and this key can push to every paired device. Store only a path.

```yaml
# ~/.open-walnut/config.yaml
push:
  apns:
    key_id: ABCD1234EF          # the APNs key id, not the ASC one
    team_id: YOURTEAMID
    key_path: /Users/you/.config/walnut-secrets/AuthKey_ABCD1234EF.p8
    # 'production' (default) serves TestFlight and App Store builds.
    # 'sandbox' serves builds you run from Xcode.
    environment: production
```

Environment variables override config, which is handy for a one-off test:
`WALNUT_APNS_KEY_ID`, `WALNUT_APNS_TEAM_ID`, `WALNUT_APNS_KEY_PATH`,
`WALNUT_APNS_TOPIC`, `WALNUT_APNS_ENV`.

Restart the server, then check:

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:3456/api/push/status | jq .apns
```

`configured: true` means pushes can be sent. `configured: false` comes with a
`reason` that says what is missing.

## Which box sends

The **primary** (your Mac). Letters live on the primary, a cloud replica relays
every `/api/v1/human-inbox` route there, and so the primary's letter store is the
only producer of letter events. The APNs key therefore only needs to exist on the
primary, and the sender is skipped entirely in cloud mode.

## The two modes

Set per device, in the iOS app under Settings, Notifications.

- **Always** (the default): every letter notifies, even while you are using
  Walnut. This is the default on purpose: a letter is a document an agent wrote
  for you, and missing one is worse than one extra banner.
- **When App Is Closed**: Slack's rule. While the app is on screen, the Inbox
  badge is the only signal; when it is not, letters notify.

The server cannot see whether an app is foregrounded, so the app tells it (`POST
/api/push/active`) and the report is treated as a **lease** that expires after 90
seconds. A phone that is force-quit or loses its connection decays back to
receiving notifications instead of muting itself forever. Every ambiguous case
resolves toward sending, because silence is the failure that matters here.

You can also mute letter types per device (`letterTypes` on `POST
/api/push/preferences`), so a chatty `info` letter need not buzz while
`action_required` does. The server never decides this for you; the only thing it
varies on its own is delivery priority (`action_required` is sent at priority 10,
the rest at 5, which affects timing and never whether a letter is sent).

## Payload contract

Renaming any of these keys breaks the tap-to-open deep link silently, so both
sides are pinned by tests (`tests/core/letter-push.test.ts` and
`ios-native/WalnutTests/PushNotificationTests.swift`).

```json
{
  "aps": {
    "alert": { "title": "New letter: <subject>", "body": "<textPreview>" },
    "sound": "default",
    "content-available": 1
  },
  "type": "human_inbox_letter",
  "letterId": "lt-m9x2k1-a4f7",
  "letterType": "review",
  "kind": "new",
  "data": { "type": "human_inbox_letter", "letterId": "lt-m9x2k1-a4f7", "letterType": "review", "kind": "new" }
}
```

The four letter fields appear twice, flat and nested, because
`LetterDeepLink.letterId(fromPush:)` accepts either shape and reading only one is
how a deep link stops working after a sender change. The body is the envelope
only: `textPreview` is capped at 300 characters and the document itself never
rides a push, it stays behind `GET /api/v1/human-inbox/:id`.

## Testing without a real device

A simulator cannot receive real APNs pushes, but it can be handed a payload
directly, which exercises everything from delivery to the opened letter:

```bash
cat > /tmp/letter.apns <<'JSON'
{ "Simulator Target Bundle": "dev.openwalnut.ios",
  "aps": { "alert": { "title": "New letter: Test", "body": "Hello" }, "sound": "default" },
  "type": "human_inbox_letter", "letterId": "lt-m9x2k1-a4f7", "letterType": "review", "kind": "new" }
JSON
xcrun simctl push <udid> dev.openwalnut.ios /tmp/letter.apns
```

Tapping the banner should open that letter. What this does **not** prove is the
Apple-side delivery half (key, topic, entitlement, token minting), which only a
real device can confirm.

## When nothing arrives

1. `GET /api/push/status`. `apns.configured: false` means the key is missing or
   unreadable, and `reason` says which. `lastError` holds the most recent send
   failure.
2. Server log, subsystem `notif`: `letter push` lines report `targeted`,
   `suppressed`, `sent` and `failed` per letter. `suppressed` above zero with
   `sent: 0` means a device's mode or type filter chose silence.
3. Common Apple-side reasons: `BadDeviceToken` usually means a sandbox token was
   sent to the production gateway (check `environment` matches how the app was
   built), and `Unregistered`/410 means the app was uninstalled. Dead tokens are
   pruned automatically so they cannot fail forever.
4. In the app, Settings, Notifications names the two client-side causes: iOS
   permission denied (recoverable only in iOS Settings, since iOS asks once per
   install), and registered-but-undeliverable (the server has no key).
