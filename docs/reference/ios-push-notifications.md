# iOS Push Notifications (Human Inbox Letters)

Every letter an agent writes to the Human Inbox can notify your iPhone. The code
for this is complete and tested, but sending needs one credential that cannot be
created from inside this repo: an **APNs auth key** from your Apple developer
account. Until you add it, the server registers your phone, reports honestly that
it cannot deliver, and logs the reason. Nothing fails silently.

The key goes on the **primary** (your Mac) and only there. If your phone is paired
with the replica you deploy, its registration is relayed to the primary for you:
see "Which box owns tokens, and which box sends".

Where this stands right now: registering a device, relaying that registration to the
primary, revoking it, and reporting every reason a letter did not notify all work
and are covered by tests. **No notification can be delivered until you add the key
below.** With none configured, `GET /api/push/status` on the primary answers
`apns.configured: false`, and every letter logs `letter push` with that reason.

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

This goes in the **primary's** config only (your Mac). The replica you deploy
never needs the key and must not be given it: it does not send.

The private key itself never goes in `config.yaml`: config gets copied between
machines, and this key can push to every paired device. Store only a path.

```yaml
# ~/.open-walnut/config.yaml   (on the PRIMARY)
push:
  apns:
    key_id: ABC1234567          # the APNs key id, not the ASC one
    team_id: YOURTEAMID
    key_path: /Users/you/.config/walnut-secrets/AuthKey_ABC1234567.p8
    # 'production' (default) serves TestFlight and App Store builds.
    # 'sandbox' serves builds you run from Xcode.
    environment: production
```

All four keys under `push.apns` are needed before anything can be sent:
`key_id`, `team_id`, `key_path`, and `environment` (which defaults to
`production`, so it is the one you can leave out unless you run Xcode debug
builds).

Environment variables override config, which is handy for a one-off test:
`WALNUT_APNS_KEY_ID`, `WALNUT_APNS_TEAM_ID`, `WALNUT_APNS_KEY_PATH`,
`WALNUT_APNS_TOPIC`, `WALNUT_APNS_ENV`.

Restart the server, then check:

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:3456/api/push/status | jq .apns
```

`configured: true` means pushes can be sent. `configured: false` comes with a
`reason` that says what is missing.

## Which box owns tokens, and which box sends

The **primary** (your Mac) owns both halves, and it has to: letters live there (a
replica relays every `/api/v1/human-inbox` route to it), so the primary's letter
store is the only producer of letter events, and the APNs key sits there too. The
sender is skipped entirely in cloud mode.

Device tokens therefore have to live on the primary as well, and that needs one
extra hop, because your phone is usually paired with the replica you deploy, not
with the Mac. So `POST /api/push/register` and its siblings (`DELETE /register`,
`/preferences`, `/active`, `/status`) are **relayed from the replica to the
primary** over the same bridge WebSocket the human-inbox routes use, as the
`server.push.*` control actions. Revoking a device relays too (see "Revoking a
device"). The replica stores nothing: one owner, one store (`push_tokens` in the
primary's `config.yaml`), one sender.

```
iPhone ──POST /api/push/register──▶ replica ──bridge: server.push.register──▶ primary
                                                                              │
                                            config.yaml push_tokens ◀─────────┘
letter written on the primary ──▶ letter event ──▶ APNs (key on the primary) ──▶ iPhone
```

Why it works this way: `config.yaml` is machine-local and permanently excluded
from data sync, on purpose (it holds provider credentials and per-machine
settings). A replica that answered the registration locally therefore wrote your
phone's token into a file that never travels, on the one box that never sends.
That was a real bug: letters arrived daily and no push was ever attempted. If you
are reading this while debugging exactly that, the two things worth checking are
below in "When nothing arrives" (items 1 and 2).

When the bridge to the primary is down, the replica answers `503` with
`retry: true` rather than a fake `200`. The iOS app records a token as uploaded
only on a success, and it re-checks that record on every launch, so a token the
primary never received is sent again the next time the app is opened.

A replica upgraded from a build that predates the relay may still carry orphan
`push_tokens` rows in its own `config.yaml`. They are inert (nothing on that box
reads or sends them) and the server logs one warning naming the count. Deleting
that block from the replica's config is optional cleanup.

### Two boxes, two name spaces

A row is identified by the device's **pairing name**, and a name is only unique
within the box that issued it: pairing a phone with the Mac and pairing another
phone with the replica can produce two devices both called `iPhone`. Each row
therefore also records where its name came from, `origin: local` (paired with the
primary) or `origin: relay` (paired with a replica), and every scoped operation
matches on name **and** origin.

What that buys you: a rotated token from one phone still replaces that phone's own
row (which is the point of the sweep, since APNs mints a fresh token on
reinstall), while a same-name phone from the other box is left alone. Without the
origin, registering the second `iPhone` deleted the first one's row and that phone
silently stopped receiving letters. With it, both rows coexist and both stay in
the send set. `GET /api/push/status` prints `origin` per row, so two rows with the same
`key_name` are readable as two phones rather than a duplicate.

The remaining rough edge is cosmetic: the same PHYSICAL phone talking to both
boxes at different times gets one row per box, so it receives one notification per
row until the dead token is pruned. Give the two pairings different names if you
want to avoid that.

### Revoking a device

`DELETE /api/devices/:name` (and `DELETE /api/auth/keys/:name`) drop that device's
push rows as part of the revoke, relaying to the primary when run on a replica.
This is a privacy operation, not housekeeping: a revoked or lost phone that keeps
its row keeps showing letter subjects and up to 300 characters of preview on its
lock screen, even though it can no longer log in.

The revoke itself never fails on this: the pairing is already gone, so if the
bridge is down the response carries `pushRevokePending: true` and the log says
`push: could not revoke this device's tokens on the primary`. Re-run the revoke,
or delete the row from the primary's `push_tokens` by hand, once the primary is
reachable.

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

1. `GET /api/push/status` **on the primary** (this is the store that counts).
   `count: 0` means no phone is registered here, so nothing can be sent no matter
   what the app shows. `apns.configured: false` means the key is missing or
   unreadable, and `reason` says which. `lastError` holds the most recent send
   failure. Asking the replica instead answers the primary's numbers with
   `via: "primary"`, or `503` when the bridge is down.
2. Server log on the primary, subsystem `notif`: there is exactly **one**
   `letter push` line per letter, whatever happened, and it is logged at `warn`
   whenever nothing reached a device. Fields: `letterId`, `devices`, `targeted`,
   `suppressed`, `sent`, `failed`, and a `reason` when no send was attempted.
   The three reasons worth knowing: `no device registered for push` (nothing is
   registered on this box; if the phone thinks it registered, the relay is the
   thing to look at), `all devices are foreground-active or muted this letter
   type` (a device's mode or type filter chose silence), and the APNs
   credential text. The remediation advice for a permanent gap is logged once per
   process, so grep the per-letter line, not the advice.
3. `push: token registered` on the primary is the line that proves a registration
   arrived, whether it came straight from the phone or over the relay. If it is
   missing, work out WHICH of the two causes you have, because they look identical
   from the phone:
   - **The phone never POSTed.** The app skips the upload when it matches what it
     last uploaded, so a phone that got a `200` from an older build (which stored
     the token on the replica) can believe it is already registered. Nothing on
     the replica logs anything, because no request was made. Confirm with
     `GET /api/push/status`: `registeredThisDevice: false` while the phone thinks
     it uploaded is exactly this case.
     **Remedy: launch the app once on a build that carries this fix.** What the
     app remembers is now the token AND the server that accepted it, so every
     install carrying an older memo re-uploads exactly once, on the next launch,
     with no user action (`QuickActionDelegate` re-checks the registration at
     every launch rather than only when the Inbox or Settings tab is opened).
     Note what does NOT work on an older build, so you do not waste the attempt:
     toggling the notification mode only logs the `404`, and unpairing and
     re-pairing never clears the memo either.
   - **The POST happened and the relay hop failed.** Then the replica logs
     `push: relay to primary failed` (bridge down) or
     `push: relay to primary rejected` (the primary refused it), and the phone got
     a `503`/4xx rather than a success.
4. Common Apple-side reasons (each logged as `apns: send failed` with the status
   and Apple's `reason`): `BadDeviceToken` usually means a sandbox token was sent
   to the production gateway (check `environment` matches how the app was built),
   and `Unregistered`/410 means the app was uninstalled. Dead tokens are pruned
   automatically so they cannot fail forever, and the prune shows up as
   `deadTokensPruned` on that letter's line.
5. In the app, Settings, Notifications names the two client-side causes: iOS
   permission denied (recoverable only in iOS Settings, since iOS asks once per
   install), and registered-but-undeliverable (the server has no key).
6. The app's own log, which it uploads to the primary
   (`/tmp/open-walnut/ios-client/<device>-<date>.log`, subsystem `push`), says what
   the launch decided. One `registration refresh` line per launch carries
   `authorization`, `branch` (`registering` or `not-granted`), the paired `server`,
   and the `memoServer`/`memoTokenPrefix` it found. That is enough to separate the
   three states that otherwise look identical: permission was never granted, APNs
   was asked and stayed silent (`branch: registering` with no following
   `apns token minted`), or the token was already uploaded to this exact server
   (`token already uploaded to this server (no POST)`). A `memoServer` of
   `legacy-no-server`, or one naming a different server than `server`, is the state
   that heals itself on this launch.
