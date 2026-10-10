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

Every way a pairing ends drops that device's push rows: the console's
`DELETE /api/devices/:name`, `walnut device revoke <name>` in a terminal, a revoke
the other box asks for by hash, and re-pairing the name from another device (a new
pairing replaces the old one). They all go through one function, `revokePairing`
in `src/core/device-auth.ts`, so a new revoke path cannot forget it.
`DELETE /api/auth/keys/:name` does the same for an API key. This is a privacy
operation, not housekeeping: a revoked or lost phone that keeps its row keeps
showing letter subjects and up to 300 characters of preview on its lock screen,
even though it can no longer log in.

A revoke also removes the pairing's copy on the other box (a phone paired with
the Mac can use the replica too, and the other way round). Otherwise the revoked
token keeps working there, and the phone could register for pushes again through
it.

Both parts can live on the other box: the rows on the primary, the copy on
whichever box did not run the revoke. So both are written to
`cache/revoke-queue/` before the pairing leaves `auth.json`, and each entry is
cleared when its part finishes. A process killed at any point leaves the server
a queue to finish, never a row or a copy nobody will remove; one killed before
its `auth.json` write leaves entries for a pairing that is still there, which
the drain drops unrun. The drain judges that under the `auth.json` lock, which a
revoke holds from its queue write to its `auth.json` write, so it never takes a
revoke in progress for one that will not land; when the lock is busy, it leaves
the entry to the next drain. When the other box cannot be reached (the bridge is down,
the replica is offline, or the revoke ran in `walnut device revoke`, which has no
bridge at all), or this box's own config write fails, the part stays queued and
the running server finishes it: at start, every minute, and when the primary
bridge reconnects. The console response then carries `pushRevokePending: true`,
the CLI says which part is left (this machine's rows, the primary's, or the other
box's copy) and that the server finishes it, and the revoke itself never fails
on it: the pairing is already gone here. A re-pair hands out the new token
without waiting for any of this (on the companion, the relay to the primary can
take up to 30 seconds).

A server keeps the copy's entry until its drain finds the copy gone, even when
its first try works, because its own retries live in memory and a restart ends
them. While that removal is queued, the box refuses to adopt the revoked token's hash
back: the other box still accepts the revoked token, and the phone asking it for
its routes would otherwise copy the pairing straight back. The refusal outlives
the queue: the same `auth.json` write that removes a pairing records its token
hash in `revokedHashes`, on each box that removes it. That token never
authenticates there again, and the hash is never adopted back, even when the
other box kept its copy (its removal was refused, or given up on after seven days).
The sidecar `auth.json.bak` carries the list too, and a lost `auth.json` is
recovered from it even when no pairing is left on the box.

A queued push part removes only the rows registered before the revoke. The revoke
time is taken right after the `auth.json` write, not before it: a registration
the phone's token authenticated a moment earlier can still land, and it has to be
older than the cutoff. One that would land later still is caught by
`POST /api/push/register` itself, which answers 401 when the pairing is gone:

- On the Mac, it checks the pairing and writes the row under that same lock, so
  the row is older than the cutoff or is never written.
- A replica relays the write, so it checks again afterwards, also when the
  primary's answer was lost on the way (a timeout, a dropped link). It also
  checks before relaying, which matters only when the revoke lands after the
  auth middleware let the request in: a retry with a token revoked before it
  arrived is refused by the middleware and never reaches this route. Each
  relayed write carries a claim, a one-way marker of the pairing that made it,
  derived from the pairing's token hash (`claims` on the row). Undoing the write
  sends the claims of the name's pairings that still hold on the replica, read
  when the undo runs: the row stays only when one of them is on it and keeps
  only those, otherwise it goes. So when the same phone was paired again under
  its name and registered the same APNs token, its row stays, and the claim of
  a revoked pairing never keeps a row. The undo is queued when the primary
  cannot be reached; it names the row by the token's sha256, so no push token
  is stored on the replica.

The name
may be paired again before the part runs (the same name, re-paired during the
outage), and the rows the new pairing registers since then are its own. The
replica sends how long ago it revoked (`revokedMsAgo`), not a time, so the
primary judges `registered_at` on its own clock. A primary too old to read it
removes every relayed row of the name, the new phone's too; that phone registers
again at its next launch, when the status check no longer finds its row.

The sender checks again at send time. Right before a push, every row registered
on this box (`origin: local`) whose name is neither a paired device nor an API key
is skipped and removed, so a row that outlived its pairing (an `auth.json` edited
or restored by hand, a revoke that raced another config write) never reaches a
lock screen. If `auth.json` cannot be read (missing, unreadable, corrupt), its
sidecar `auth.json.bak` judges instead, and the rows it finds unpaired are held
back but not removed: the sidecar can lag the real file. If neither can be read,
or `config.yaml` cannot be (its API keys are unknown then), nothing is judged and
the server logs `push: device registry unreadable`. A row registered through the
replica (`origin: relay`) cannot be judged on the primary, which does not hold the
replica's pairings; its revoke relays to the primary as described above.

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

## Which service each device gets

Every push leaves through one function, `deliverPush` in `src/core/push/deliver.ts`.
Letters use it, and so does the general subscriber in
`src/core/push-notification.ts` (scheduled-job notices, background agent replies,
session results and errors, triage chat updates). Those branches are unwired: no
producer on a running server sends those events to that subscriber, so today only
letters notify a phone. Connecting one is a product decision, because it makes the
phone buzz for that event. Forensic incidents never push: they are developer
diagnostics and stay in `/api/incidents`.
`deliverPush` routes each device token by the token's shape:

- a raw hex token, which the native app registers, goes to Apple over APNs;
- an `ExponentPushToken[...]` row, left by the retired Expo build of the app, goes
  to Expo. Such rows keep working, but nothing mints new ones.

Notification text never goes to Expo for any other token. The `kind` stored on a
row is only a label, so a label that disagrees with its token cannot change the
route. A token Expo or Apple reports as dead is removed. The general notifications
push only while no web client is connected, never while quiet mode holds, and
never from a cloud replica; letters follow the per-device modes above.

Log lines name a device by `tokenTag`, a short hash of its token, never by the
token or a slice of it, and any text a push service sends back is scrubbed of the
token before it is logged.

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

     On top of that one-time re-upload, a launch that finds the memo already
     matching now asks the sending box whether it agrees: one `GET
     /api/push/status`, and the memo is dropped only when no listed row holds this
     phone's token (each row's `token_prefix` is compared against the token APNs
     just minted). The memo alone could never catch any of this, because all it
     records is that some box returned a 2xx, and a replica on pre-relay code did
     exactly that while keeping the row in its own config. `registeredThisDevice`
     is only the fallback for a server too old to list rows: it is keyed on the
     caller's bearer-key name, and a phone on a trusted LAN with no verifiable
     bearer is filed under a shared placeholder name, so a second such phone would
     read `true` without ever having registered. A missing answer (an older
     server's absent field, a `503`, an offline phone) leaves the memo alone, and
     the one `launch reconcile` line per launch reports which rule decided in
     `decidedBy`.
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
