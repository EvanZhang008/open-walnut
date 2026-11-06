# Passwords

Walnut keeps a password vault on the machine that runs the Walnut server (the Mac, the
leader). The web console and the Mac app have a Passwords app; the browser extension, the
iPhone app (and its AutoFill extension) and agents use the same vault.

Code: `src/core/vault/` (crypto, store, sessions, generator, TOTP, site matching, import,
export), `src/web/routes/vault-v1.ts`, `web/src/components/passwords/`,
`web/src/components/settings/sections/PasswordsSection.tsx`.

## Where it lives

`$XDG_STATE_HOME/open-walnut/vault/` (default `~/.local/state/open-walnut/vault/`), outside
the git-synced data home, like the fleet secrets master. A throwaway server (tests, an
ephemeral server, a data home in a temp or task dir, a fake HOME) keeps its own vault in
`<data home>/vault` and never opens the real one. `WALNUT_VAULT_DIR` (absolute) overrides both.

| File | Holds |
| --- | --- |
| `vault.json` | ciphertext, except the KDF parameters and the master password hint: the wrapped vault key, every item sealed |
| `machine.json` (0600) | the Secret Key, and the machine key while "agents may ask while you are away" is on |
| `backups/vault-<date>.json` | the previous `vault.json`, one per day, newest 14 |
| `sessions.json` (0600) | the open windows a Walnut restart keeps: token hashes, limits, the boot, an HMAC (Unlocking) |

## Keys

All AES-256-GCM with a fresh 12-byte nonce and an additional-data label naming what each
ciphertext is (`walnut-vault:<vault id>:item:<item id>` and so on), WebCrypto only, so the
server, the web app and the extension run the same code.

- **Item key**: 32 random bytes per item, made new on every write, encrypting the item's JSON.
- **Vault key**: 32 random bytes, wrapping every item key.
- **Account unlock key**: the vault key's first wrap. Two secrets, as in 1Password:
  `pwKey = PBKDF2-HMAC-SHA256(master password NFKC, salt, 650,000)`, then
  `AUK = HKDF-SHA256(pwKey || Secret Key, aukSalt, "walnut-vault-auk-v1")`. The client derives
  `pwKey` where the password is typed, so the master password itself never crosses the wire
  (a page with no WebCrypto, plain http from another device, sends the password and the
  server derives it). The Secret Key is 128 random bits, shown once at setup as
  `W1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX` and saved in the recovery kit.
- **Machine key**: the vault key's second wrap, so the server can open the vault after a
  restart and serve an agent request the person approves from the phone while no window is
  unlocked. Off by default. Turning it on or off asks for the master password again, and
  Settings says what it costs: any program running as the person on this Mac can then read
  `machine.json` and open the vault without the master password. While it is off the server
  holds the vault key only while some window has Passwords unlocked; when the last one locks
  or goes idle, the key goes.

- **Recovery key**: the vault key's third wrap, for a forgotten master password.
  `RK = HKDF-SHA256(recovery code || Secret Key, vault id, "walnut-vault-recovery-v1")`, where
  the recovery code is 128 random bits shown as `R1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX` in the
  recovery kit, so no slow KDF is needed. The code is kept nowhere but the kit: every new
  vault key comes with a new code (below). `recoveryFor` (a hash of the password wrap it was
  made beside) tells a wrap an older Walnut left under an earlier key: it reads as no recovery
  code (`hasRecovery: false`, recovery answers `recovery_stale`). A vault set up before
  recovery codes has none until Settings makes a kit.

A copy of `vault.json` alone (a backup, a stolen disk image without `machine.json`) needs
both the master password and the Secret Key. A process that reads both files without the
machine key can still try master passwords offline at PBKDF2's pace, as with any local
password manager that keeps its Secret Key on the device.

A new master password, turning the machine key off, a new recovery kit and a recovery make a
new vault key and wrap every item key again under it (the items' own ciphertext stays), and the
sealed side files are sealed again. Each also makes a new machine key when that is on, and a
new recovery code when the vault has one, returned once as the new kit (Settings saves it and
shows the code): a code is never carried to a new vault key, since whoever held the old key (a
copied machine key, an old backup with its password) could read a carried code. So an old
password with an old backup, a machine key copied earlier, or an old recovery code (with any
backup) opens nothing written since. A new master password also locks every other window.

Each of these steps writes its files in an order a crash cannot turn against the person: the
machine key is written before the wrap it opens and removed before the vault key changes, a
side file is sealed under the new key as `<name>.next` before `vault.json` takes that key and
renamed after, and a machine key that does not open the vault (a crash between two writes)
only means the password opens it. A new vault sets another vault's `machine.json` aside as
`machine-<vaultId>-<time>.json`, since it holds that vault's Secret Key.

## A forgotten master password

Like Apple's recovery key, not a cloud reset: nothing outside the person's own machines can
open the vault. The recovery kit (shown at setup, an HTML file to print) holds the Secret Key
and the recovery code. "Forgot master password?" on the lock screen takes the code (and the
Secret Key when this machine has none) and a new master password (`POST /api/v1/vault/recover`):
the vault gets a new vault key, a new machine key when that is on, a new recovery code and the
new password, every window and agent grant ends as with Lock all, and the new kit is shown
until the person confirms it (the page asks before a reload would lose it). Walnut keeps no
copy of a code, so every new one is marked unsaved in `vault.json` (`recoveryUnsaved`) until
the kit's confirm (`POST /api/v1/vault/recovery-kit/confirm`) reaches the server: a lost answer,
a download the browser dropped or a page left early leaves the mark, and Passwords and Settings
then ask for a new kit instead of trusting a code nobody saved. Each code works once. A wrong code counts like a wrong password
under the same brake, and the code crosses only a private link (this machine, https,
Tailscale). Settings → Passwords → "Make a new recovery kit" (the master password again,
`POST /api/v1/vault/recovery-kit`) makes a new code and a new vault key; the old code opens
nothing from then on, not even with a backup of `vault.json` from before.
Anyone holding the kit can open the vault on the machine that has the Secret Key, so the kit
says to keep it away from the computer. Security questions were left out on purpose: their
answers are guessable or public and carry far fewer bits than the vault needs.

An older Walnut that rekeys the vault leaves the recovery wrap under the earlier key; the new
one reads it as none (above), so the lock screen and Settings ask for a new kit.

## Unlocking

The vault being open on the server is not a person's unlock. Every item read or write
through the API carries a vault session (`x-walnut-vault-session`) that only the master
password buys (`POST /api/v1/vault/unlock`). How long a session lasts is the person's choice,
"Keep Passwords unlocked" in Settings → Passwords (`passwords.unlock_for`,
`src/core/vault/unlock-length.ts`): 15 minutes unused (with a 12-hour cap), 1 hour, 12 hours
(each from the unlock), 48 hours after the last use (renewed by every use, no cap), until Walnut
restarts, or forever. Forever is the machine key (the vault reopens by itself after a restart,
below); moving to or from it asks for the master password. A config with no choice reads 48 hours,
and a new vault's setup writes it down. An install that already had a vault and no choice written
kept the 15-minute idle lock, so the first start of this version writes `unlock_for: idle` for it
once (`src/core/vault/unlock-migrate.ts`): nobody's lock gets longer by an upgrade. A config an
older Walnut wrote with only `auto_lock_minutes` is that person's choice and reads as the idle
choice with those minutes. A change of the limits (the choice, the idle minutes, the machine key
turned off) only ever shortens the windows open now (`retimeSessions`, on every config write, an
edit of config.yaml outside Walnut included): each keeps the shorter idle time and length of the
two, so a shorter one may lock them at once, and a longer one applies from the next unlock. The status
answers `unlockFor`, `lockAfterIdleMinutes` (null when no window counts its own idle time; 48
hours is ended by the server's own idle clock, so one tab left untouched while another is used
never locks both) and `autoLockMinutes`, a number for older clients (2880 for 48 hours, until
restart and forever). The one-time code refreshing by itself and a status read marked
`x-walnut-vault-quiet: 1` (a page checking it is still unlocked) do not count as use.

**A Walnut restart keeps the windows** (`src/core/vault/session-store.ts`), every choice but until
restart: `sessions.json` (0600) beside `vault.json` holds each open session as the sha256 of its
token (the token itself is only in the client), its client, device, limits and times, which boot of
this computer wrote it (the boot time from `os.uptime`, and Linux's boot id), and an HMAC under a
key derived from the vault key. It is written on every unlock and end, and at most once a minute
for use. At start every vault route waits for the restore: sessions past their clock go; a file
from another boot restores nothing (a restart of the Mac locks every window); if live ones remain,
the vault reopens without the person when it can (the machine key, or this Mac's keychain on the
person's real Walnut, never on a throwaway server), the HMAC is checked and they come back, else
all are dropped and the windows show Unlock. A shorter choice made while Walnut was down applies to
the restored windows, and when it ends every one the vault closes again. Walnut's own keychain
unlocks (the daily Bitwarden sync, the unlock at start) are not kept: a restart unlocks again.
Turning agents-while-away off seals the file again under the new vault key at once, so a restart
right after it still restores. So a stolen `sessions.json` opens nothing (no token
in it), a session written in by something that cannot open the vault is refused, and a new master
password (a new vault key) ends every window the file still names except the one that changed
it. An older Walnut never reads the file: going back a version locks the windows as before, and a
Lock made there is not seen by it, so a newer Walnut started again on the same boot may bring back
a window the older one locked while its token is still in that browser.

**Lock.** A window's Lock (`POST /api/v1/vault/lock {everywhere: true}`, the Passwords page's and
the extension popup's Lock button) ends every window's session and the extension's; the other tabs
show the lock screen at once (a `storage` event), another browser at its next read or within a
minute (a quiet status check while the page is shown), and an open extension popup or side panel
within a few seconds (it asks Walnut every 3 s while it is shown, and any refusal of its unlock
brings its lock screen with the password field, never an error). A lock with no body ends
only the caller's own session: what an older client's Lock meant, and what an auto-lock (a tab's
idle time, the extension's own timer, its browser start) sends. Lock all also ends every agent
grant. A Lock answers only after `sessions.json` is written without the ended sessions; when that
write fails the file is removed, so a restart never brings a locked window back. The web app keeps its token in localStorage (`walnut.vault.session`, never mirrored by
ui-prefs), shared by every tab and window of that browser, a reload and the Mac app's page recycle;
a token an older page left in sessionStorage is carried over once. A dead token is dropped only
while it is still the one stored, so a tab's 401 never drops a newer unlock another tab made. With
the idle choice, the tabs share one idle clock (`walnut.vault.active`). Wrong passwords: five free, then each try waits twice as long as the last
(30 s up to an hour). Every check of the master password counts (unlock, export, a new
password, the Secret Key, a new recovery kit, the machine key switch) and so does a recovery
code, and only one runs at a time, so a burst of
parallel guesses is refused rather than checked. An export asks for the master password again.
A window that read the KDF before another one changed the master password is told
`kdf_changed` and reads it again, instead of being charged a wrong password.

The typed master password crosses the wire only from a page with no WebCrypto, and only over
this machine, https or Tailscale: the status says whether the link is private (`privateLink`),
the page sends nothing otherwise, and the server refuses it anyway. A forwarded-proto header
is not trusted. Every check runs its whole cost (deriving a typed password included) under the
brake, and the window's session is made inside the check, so a close cannot fall between them.

When the last window's session runs out by itself, the vault closes as if it had been locked
(with the machine key off). Known limit: Lock all is a person's call that needs no session, so
any page on a link the gate accepts can end every window's unlock; it never opens anything.

Known limit: the token itself is on disk in the client, in the browser profile (the web app's
localStorage, the extension's IndexedDB), as a session cookie would be. A process running as the
same user on that computer can read it there, and is outside what this protects against: it can
read the master password from the keychain item too. What keeps a page from reading it is the
origin: nothing but Walnut's own pages runs on Walnut's origin. A document Walnut serves from a
file (an agent's HTML report, an SVG in a repo, previewed in Files or opened raw) is sent with a
CSP `sandbox` that gives it an origin of its own (`src/web/untrusted-doc.ts`), and the preview
frame has no `allow-same-origin`, so a script in it cannot read this origin's storage.

The console cannot reach into such a page either, so what the Files preview did inside it goes
through a small script Walnut puts into every previewed HTML document (`src/web/preview-bridge-script.ts`,
the console's side in `web/src/components/common/preview-frame.ts`): the selection (with Ask here
and Comment), the page's text, the question and comment marks (located by the console in that
text, painted and hit-tested by the page), find, link clicks, the plugin link menu on a
right-click, the scroll position and Esc. Each side takes only the named messages, from the
other window only, each checked for its fields and sizes; nothing the console sends is run,
written as markup or navigated to. The console loads into the frame only a file it resolved
itself, and a plugin acts on a link (a click, or its menu on a right-click) only right after a
real press on that same link in the page, with the browser reporting the user's activation (a
browser that reports none counts as no press).

Known limits of the isolated preview: from a remote browser (another device, a tunnel), Chromium
sends no cookie with the page's subresource requests (images, stylesheets, scripts), so they get
`401` and the page renders without them; WebKit sends the cookie and is not affected. Chromium
also sends no `Referer` from the page, so a root-absolute reference (`/tmp/report/x.png`) is not
redirected onto the file route there (`src/web/file-raw-referer.ts`); relative references work
in both. A module script, and a `fetch()` or XHR to any Walnut URL (the page's own folder
included), comes from the page's opaque origin (`Origin: null`), which the origin check refuses, so
those do not work in a preview: open such a page through a server of its own.

### Master password hint

Setup, a new master password (Settings) and a recovery each take an optional hint (`hint`, at
most 100 characters, `src/core/vault/hint.ts`). It is kept in plain text in `vault.json` (no
key opens a locked vault, so a sealed hint could not be shown) and `GET /api/v1/vault/status`
returns it while locked (`hint`, absent when there is none). Every unlock screen (the Passwords
page, the extension's popup, its unlock window and the side panel's Passwords tab) shows a
"Show hint" link under the password field, and the hint at once after a wrong password. The
person is told it is readable by anyone who opens the unlock screen.

A hint may not give the password away: it is refused (`400 bad_hint`) when it contains the
password (compared in lower case, NFKC, and again with all spaces removed) or, at 4 characters
or more, is part of it. The page checks all of this before sending. The server checks again
fully only when it got the typed password; from a page that sends only the derived password key
(the usual case) it can tell only a hint equal to the password, by deriving the key from the hint
as typed, without spaces and in lower case (four derivations at most) and comparing it with the key
sent. A hint that contains the password or is part of it is caught by the page alone.
Settings → Passwords → "Master password hint" changes it (`PUT /api/v1/vault/hint`, the
master password again so it can be checked, under the same brake) or removes it (`hint: ""`, a
session only). A new master password takes the hint sent with it; one sent without (an older
client) drops the old hint, which was about the old password. An older Walnut opens such a
vault as before, keeps the field when it writes the file (it clones what it read) and never shows
it; a new master password set there leaves the old hint in place.

### Unlock with this Mac's keychain

On macOS a person may keep the master password in the login keychain (generic password, service
`walnut-vault-master`, account the macOS user), so Walnut can unlock without typing
(`src/core/vault/keychain-unlock.ts`). There is no HTTP route for it: a request that could open
the vault with no password typed would open it for anything that can reach the server. Walnut
uses it only itself: at server start when the choice is until restart or forever and the vault is
not open yet (`src/core/vault/background.ts`; never on an ephemeral or test server), at server
start to reopen the vault for the windows a restart kept (`session-store.ts`, only when some are
live, opening no session of its own), and in the
daily Bitwarden sync when the vault is locked, ending that session afterwards. It reads the item
with `security find-generic-password -s walnut-vault-master -a <user> -w` in a child process with
a timeout (never a sync call on the event loop), and unlocks exactly as a typed password does: the
same KDF, the same wrong-password brake. The password is never logged and never returned. Settings
shows "Unlock with this Mac's keychain: on/off" (`GET /api/v1/vault/keychain`, a person only, which
checks for the item without reading it) and a "Remove from keychain" button (`DELETE
/api/v1/vault/keychain`, needs an unlocked window). The lock screen always asks for the master
password. Walnut never writes the item: the person adds it with `security add-generic-password -s
walnut-vault-master -a "$USER" -w`.

## Who may open it

A person only: no session caller (`x-walnut-caller-sid`), no CLI automation mark, this
machine or a paired device, the approvals rule. Agents never get a vault session; they use
the vault through their own ops, each use gated by the item's agent access and a person's
approval. A test run may read the status and nothing else. The cloud companion never carries
these calls (`/vault` is in its kept routes, `src/web/v1-forward/policy.ts`), because it
would see them in the clear between its TLS and the bridge (the one exception is the ciphertext the
iPhone opens itself, "iPhone" below), and a follower answers
`vault_not_here`. No vault answer is kept in the applied-ops ledger, a plain file kept for
days, and none is answered from it (`SECRET_ROUTE_RE` in `src/web/middleware/op-id.ts`).

## Writes

Every change works on copies of the file and the items and replaces the in-memory state only
after the write succeeded, so a full disk leaves memory and disk the same. Changes run one at a
time, and a read that finds the file changed waits its turn before reading it again, so it never
takes a write still landing for a backup put back. A close (Lock all, the last window gone)
wins over a change still running: its write stands, and nothing goes back into memory. Each write is a temp
file, fsync and rename; the previous `vault.json` is kept once a day in `backups/`. A
`vault.json` put back by hand (a backup restored) is read again. When a server keeps its vault
in the data home (a throwaway server), git sync never carries it (`/vault/` in its ignores).

## Items

Types: login, secure note, card, API key (with the env var a command gets it as), identity
(later). Every item has favorites, tags, custom fields (hidden or not), notes, password
history (the last 20 passwords with when each was replaced), trash (purged after 30 days),
`agentAccess` (`never`, `ask`, `allow`) and `sensitive` (an agent's use needs Face ID or
Touch ID). Sites are normalized at save (`github.com` becomes `https://github.com`) and
matched by registrable domain with the public suffix list, private suffixes included, so two
`github.io` sites never match each other and an https login never fills an http page.

Import (dry run first, duplicates skipped): Bitwarden JSON (passkeys kept as they came) and
CSV, 1Password CSV, Apple Passwords CSV, Chrome CSV, Firefox CSV. Export: CSV with
Bitwarden's columns, or Walnut JSON.

The security check (weak, reused, not changed in a year, saved for plain http) runs on this
machine; no password or site leaves it.

## Browser extension

`packages/browser-extension` is one source for Chrome (and Edge, Brave, Arc) and Firefox (128
or later), built by `bun run extension:build` (part of `web:build` and of the compiled release
build) into `dist/extension/{chrome,firefox}` and the downloads this Walnut serves at
`/downloads/walnut-extension-{chrome,firefox}.zip`. Settings, Browser extension shows
how to load it and lists the connected ones with Remove.

**Setting it up from Walnut, and keeping it current.** A browser loads an extension that is not
from its store only on the person's own two clicks (Chrome: Developer mode, then Load unpacked),
so in Chrome on the machine Walnut runs on, Settings offers **Set up in Chrome**
(`POST /api/v1/browser/extension/setup`, `core/browser-control/extension-install.ts`): Walnut
unpacks the extension it ships into a folder of its own (macOS
`~/Library/Application Support/Walnut/Browser Extension/chrome`, Windows `%LOCALAPPDATA%`,
else `$XDG_DATA_HOME/walnut/browser-extension`; per machine, never synced, not a cache), and on a
Mac copies the folder's path and opens `chrome://extensions`, and the page shows the two steps
left. Each build is named: the build script hashes what the extension runs into the manifest's
`version_name` (`0.6.25 build <hash>`) and `downloads/walnut-extension.json`. At every server
start, and whenever the extension asks which build there is (`GET /api/v1/browser/panel`
answers `extension: {version, build}`), a folder set up this way that holds another build gets
this one; the extension (`self-update.ts`, an unpacked copy only, every 10 minutes and at browser
start) reloads itself when Walnut names a build it is not, once per build, so a copy loaded from
some other folder never reloads in a loop. Pages already open get the new copy when reloaded. A
throwaway server (ephemeral, a test) keeps the folder in its own data home and opens nothing.

**Connecting.** The popup's Connect opens `<walnut>/connect-extension` in a tab it remembers
(storage.session, per tab). That page finds the extension through its content script
(`window.postMessage`, its own origin only); on the person's click it mints a browser sign-in
code (`POST /api/devices/browser-code`, the person at this machine only) and hands it over,
and the extension trades it at `POST /api/v1/browser-pair {code, client:"extension"}` for its
own device token (device `extension-<hex>`, a browser in Settings, shown as "Walnut extension
(Chrome on Mac)"). That handshake answers no other page. (A page can still tell the extension
is installed, from the elements it draws or the pages it exposes for framing; it learns nothing
more.) Connecting again removes the device it replaces. The popup also takes a code made in Settings, Devices. The address must be https, this
machine or a Tailscale address: plain http to another computer would carry everything
readable, so the extension refuses it.

**Unlocking.** The extension is a window like any other: the master password buys it a vault
session, kept in its IndexedDB beside the device token (closed to content scripts; storage.session
holds only a mark that changes with it, which its pages follow), so a service worker restart and a
browser restart keep it. Its own auto-lock (Settings in the popup) defaults to "Walnut's setting":
no clock of its own, Walnut's length ends it, and the popup says that length in words. A time picked
there (or When the browser closes, Never while the browser is open) also locks at every browser
start, as the memory-only session of an older extension did; an older extension's saved default of
15 minutes reads as Walnut's setting, since it was written with every setting change. A session an
older extension kept in storage.session is carried over once. It derives the password key with WebCrypto, after checking the KDF the
server names against the same floor the server holds (PBKDF2-SHA256, 600,000 iterations or
more, a 16-byte salt), and sends that, never the password. The server takes a derived key, like
a typed password, only over a private link: https, this machine (a loopback connection with no
proxy header, addressed to a loopback name; a loopback request addressed to another name is how
a header-less relay from the network looks, and is refused), Walnut's tunnel while what it
publishes is https, or Tailscale. A derived key also comes through the person's own TLS proxy
on this machine (loopback with a forwarded proto of https); a typed password does not, since a
browser types one only on plain http. A key replays as the password wherever the Mac holds the
Secret Key. A session a device token opened holds only with that token (every read of a vault
session checks it) and ends when the device is removed in Settings; one removed by `walnut
device revoke`, another process, ends at its next use. The last session ending that way closes
the vault as an auto-lock would. The reads the extension makes by itself carry
`x-walnut-vault-quiet: 1`, so browsing, and opening the popup, never keep the vault unlocked;
a fill or a copy does. Disconnect locks its session and removes its device.

**One unlock on this computer.** With "Walnut's setting", the extension on the computer Walnut runs
on needs no password of its own while the person has Passwords unlocked there: a Walnut window or
the Mac app unlocking, another browser's extension unlocking, or the keychain unlock at start.
Its status then says `canJoin`, and `POST /api/v1/vault/join` gives it a session of its own
(`sessions.joinSession`), held only with its device token and part of that one unlock (`source`
on the session): it holds only while that unlock does, so its expiry, a Lock of that window and
Lock all end both, and a use of it renews that unlock, as a use in any window does. Sharing never
makes an unlock last longer, and a restart never brings a shared session back without its unlock. An open popup or side panel takes it within a few
seconds, a popup opened later at once. Only that extension may: the device must be a paired
Walnut extension (`extension-<hex>`, which only the person at this computer can pair), the request
must come over this computer's own network path (a loopback connection with no proxy header,
addressed to a loopback name, off the tunnel's port) with no session's header, and the unlock it
shares must have been made the same way, in a browser (it sends an Origin; a script or the CLI is
no window and shares nothing), marked `here` on the session and kept by `sessions.json`. So a
phone, a browser elsewhere, the companion and an unlock made through Walnut's tunnel share nothing.

The other way round works too: a locked Walnut window on this computer (the `/passwords` page,
Settings, an approval's "Unlock to approve", the Mac app's page) shares an unlock the person made in
the extension or in another window, with no password, by the same rules. A page and a local process
(an agent's `curl` with Walnut's Origin) look the same to Walnut, so a window needs a secret of its
own, as the extension has its device token: its browser key. When the person types the master
password in a Walnut window here (setup, unlock, recovery: Walnut's own Origin over this computer's
own path, no device token, no session's header), the answer carries a `browserKey`, which the page
keeps in localStorage (`walnut.vault.browser`, never mirrored) and sends in `x-walnut-vault-browser`.
`browsers.json` beside the vault holds only the sha256 of each key, sealed with the vault key like
the other side files (a file written by anything that cannot open the vault counts for nothing; a key
change reseals it), and forgets a browser unseen for 90 days, and all but the newest 20
(`src/core/vault/browser-keys.ts`). A key alone opens nothing: with it, the status says `canJoin`
only while an unlock made here is live, and `POST /vault/join` (with the window's Origin) gives the
window a session of its own on that unlock's clocks, held by its token as a window's own unlock is
(`joinSession(..., 'window')`). So each browser on this computer types the master password once;
after that, one unlock anywhere here opens it. `vaultApi.status()` joins by itself, and every
window follows the vault live: each change of who holds an unlock (an unlock, a share, a Lock, an
expiry, a self-lock, a new master password; never a mere use) is announced to every open Walnut
window as `vault:changed` (`sessions.ts`, one event per burst, carrying nothing of the vault), and
each window then reads its own status quietly (`web/src/api/vault-live.ts`; a reconnect reads it
once too). So a Lock in the extension or another window locks an open Passwords page within about
a second, its items gone at once, and an unlock there opens a locked Passwords page, Settings →
Passwords and a guarded approval card with no reload. An approval card that needs an unlock reads
the vault the moment it arrives, so it says Approve while it can share one and "Unlock to approve"
(which asks for the master password) only when there is none. Every web file that reads the vault
state imports the follower (`tests/web/vault-live-guard.test.ts`); a locked Passwords page and an
open "Unlock to approve" form still look every 3 s behind it, in case the socket is down. A window that locked only itself (its own idle
lock, `POST /vault/lock` with no body) is recorded under its key's id (`window:<id>`) and shares
nothing until the person unlocks again; a person's Lock ends every shared window with the rest.
A new master password or a recovery ends every browser key (the window making the change gets a
new one) and shares no unlock made before it with any window or extension: only an unlock typed
with the new password is (`sessions.endJoinsBefore`, kept with the self-locks in `sessions.json`).
So a browser that was let in before types the new password once, and the window that changed it
keeps its own unlock without sharing it.

Known limit: a forward to Walnut's port
that adds no proxy header (`ssh -L`, socat, a bare `proxy_pass`) makes a request from elsewhere
look like this computer's, the same limit `src/web/middleware/local-trust.ts` names, which trusts
such a request with no credential at all (more than sharing gives; sharing also needs the
extension's device token or a window's browser key). Walnut's own tunnels connect to its tunnel port, where loopback is
never trusted, so through them nothing is shared. A Lock ends the shared sessions with the rest,
and an extension that locked only itself (its own timer) shares nothing until the person unlocks
again, after a Walnut restart too (`sessions.json` keeps that record, signed with the sessions). Every other auto-lock choice in the popup locks at browser start and after
its own time, which sharing would undo, so with those the extension unlocks with the password.
The Playwright fixture's one vault serves specs side by side, so there (`WALNUT_TEST_VAULT_JOIN=named`)
only the extension (`device`) or window (`browserKey`) a spec names through `POST /api/test/vault-join`
shares an unlock. Tests: `tests/e2e/vault-join.test.ts`, `tests/e2e/vault-window-join.test.ts`,
`tests/core/vault/session-join.test.ts`,
`tests/core/browser-control/extension-popup-race.test.ts` (a late answer never draws over the lock
screen: `popup-view.ts`), `tests/e2e/browser/extension-one-unlock.spec.ts`.

**What lives where.** The background holds the device token and the vault session (its
IndexedDB, which content scripts cannot open) and, for 5 s while unlocked, the item summaries (so a
Lock elsewhere shows within seconds); a content script holds neither. Each kind of message is accepted only from the page that may
send it (the popup, the menu, the save bar, a content script). A fill fetches the item and
sends its username and password only to frames on the top page's origin that reported a login
form (or to the one frame whose menu was picked), with that origin, which the frame checks
again; it keeps nothing.

**The in-page menu and save bar** are the extension's own pages framed into the site, inside
closed shadow roots, so the site cannot read them. Each open has a one-time nonce that every
message from it must carry; the content script hands it to the frame by `postMessage` to the
extension's origin, never in a URL the page can read, so a page that frames `menu.html` itself
gets nothing, and a frame the page navigates (a second load) is closed. Their hosts carry
`!important` styles, and their shadow roots turn off the host's `::before` and `::after`, so a
stylesheet cannot hide them or draw over them from the host itself; a script that changes a
host, or an element put after one (it would paint on top), closes it. Before a fill or a save
the page is checked once more: the page faded or hidden around them, or something in the top
layer (a popover, a modal dialog, full screen) over them, and Walnut does nothing and closes
them. Their buttons act only after the frame has been on screen for half a second and, in
Chrome, only while nothing covers or fades it (IntersectionObserver v2); Firefox has no such
signal, so there the wait and the checks before acting hold. The menu
opens by itself only right after the person clicked or tabbed into an empty field, never on a
focus a script made or a fill moved; typing your own value closes it.

**What it fills.** Only a login whose saved site has the page's registrable domain (the
same rule as everywhere, `url-match.ts`: an https login never fills an http page), and only in
the top page or a frame on the top page's origin: a login form framed in from another site, or
a sandboxed frame, gets no icon and no fill. Every fill, menu or popup, checks the item against
the page again in the background. It does nothing on Walnut's own pages (so its master
password is never offered for saving): every Walnut page carries `<meta name="walnut-app">`,
under whatever address it is opened (a mark a page can only use to turn the extension off),
and the connected address and its loopback aliases are known besides.

**Saving.** A login is offered only when the person sent it (a trusted submit, a click on a
button that sends, or Enter) and typed its password (or used the strong password the menu
made): a page that fills a form itself offers nothing. The field counts whatever its type
while typed, so a "show password" switch does not lose it. It is kept in the background for 3
minutes (expired ones are swept away), never in the page, and offered on that site, or on the next page within 20 seconds (a
sign in that lands elsewhere): Save for a new one, Update when a saved login with that username
has another password, nothing when it is the same. A two-step sign in carries the username of
its first page. Seen while locked, the bar asks to unlock, and once unlocked (the popup, or
anywhere the extension's session changes) it is compared and offered. "Never for this site" is
kept per registrable domain. A sign-up or password-change field offers a strong password (the
generator's defaults) in the menu, fills every new-password field, and the sign-up is saved the
same way. Ctrl+Shift+L (Cmd+Shift+L) fills the page's one login, or opens the top page's menu
when there are several.

**Firefox.** The same build with an event-page background, a gecko id and
`data_collection_permissions: none`; `web-ext lint` passes clean. Until a signed build is
published it loads as a temporary add-on (about:debugging), which lasts until Firefox quits.

Tests: `tests/e2e/browser/extension-passwords.spec.ts` (Chromium with the extension loaded, test
sites on `*.example.test`, the attacks above included), `tests/e2e/browser/extension-form-detect.spec.ts`
(the form shapes), `tests/scripts/build-extension.test.ts`, and the server side in `tests/e2e/vault.test.ts`.

**Agents in the browser.** The same extension can let Walnut agents work in tabs of their own, on sites the person approves; the connect page asks once (a checkbox, on by default), and the extension's Settings change it later. See [Agents in your browser](browser-control.md).

## iPhone

The iPhone app is a password app iOS offers everywhere (Settings, General, AutoFill & Passwords,
Walnut): logins above the keyboard and in the password sheet in Safari and other apps, two-step
codes in one-time code fields, and sign in with the passkeys kept in the vault. The app's own
Passwords screen (Settings, Passwords) lists, searches, shows and copies every item.

Code: `ios-native/Shared/Vault/` (crypto, models, cache, Keychain, the fetch, site matching, TOTP,
passkey signing, the identities given to iOS), `ios-native/Shared/VaultUI/`, the AutoFill extension
`ios-native/WalnutAutoFill/`, the app's `Walnut/Stores/PasswordsStore.swift` and
`Walnut/Views/Passwords/`, and the server's `src/web/routes/vault-sealed-v1.ts`.

**The phone opens the vault itself.** It never gets a vault session and no item crosses the wire in
the clear: `GET /api/v1/vault/sealed` answers `vault.json`'s header (format, version, id, kdf,
aukSalt, the password wrap; never the machine or recovery wrap) and a tag per item, a hash of its
two nonces, which change on every seal, a new vault key included; `POST /api/v1/vault/sealed/items
{ids}` answers those items' sealed `key` and `data` as stored. Both stay under the companion's
forward limit (pages by `next` and `more`), and they are the only vault routes the cloud companion
carries to the Mac (`v1-forward/policy.ts`): it sees the ciphertext and its outline (the item ids,
how many, when the vault last changed, the key settings), never a title, a hint or a key. The same person gate as every
vault route applies (no agent, no test run). The phone keeps what it fetched in the app group it
shares with its extension, and fetches only items whose tag changed. A vault set up again on the
Mac (another id) starts the phone over; a newer `version` is refused with "update the app".

**Setting it up** takes the master password once. The phone derives the password key itself with
the same KDF and floor as the extension (PBKDF2-SHA256, 600,000 iterations or more, a 16-byte
salt), then needs the Secret Key: over a private link (this Mac, https, Tailscale; the status's
`privateLink`) it reads it with the existing unlock, `POST /vault/secret-key` and lock, so the
master password's key crosses only links a typed one may; on any other link (the cloud companion,
plain http on the Wi-Fi) Walnut never sends it, and the person pastes it from the recovery kit
or the Mac's Settings (Passwords, Recovery and advanced, Show Secret Key). The vault key goes into the Keychain behind Face ID (biometry of the current
enrollment, else the passcode), this device only, never in a backup; the Secret Key beside it, this
device only. A new master password on the Mac makes a new vault key: the phone sees a new wrap whose
items its key no longer opens and asks for the master password again. Face ID enrolled anew loses
the key the same way. "Remove from This iPhone" and Disconnect delete the cache, both keys and the
token copy, and empty iOS's list; the vault on the Mac is untouched.

**AutoFill.** The extension holds a copy of the phone's device token (the shared Keychain group)
and fetches the newest ciphertext itself each time it opens, so a login saved in the browser
extension or on the Mac is in the sheet right away. iOS's QuickType suggestions come from the list
Walnut gives it (`ASCredentialIdentityStore`: site, username, item id; never a secret), replaced
whole every time the items are opened on the phone (in the app or the sheet), so a new login shows
above the keyboard after the next unlock. Every fill needs Face ID: the vault key is never readable
without it, so `provideCredentialWithoutUserInteraction` always hands over to the sheet. Turning
Walnut on uses iOS 18's own prompt from the app; iOS then shows the extension's setup screen, which
unlocks once and gives iOS the list.

What Apple allows and what Walnut does (iOS 18 is the app's floor): passwords (iOS 12+), passkey
sign in (iOS 17+, ES256 with the vault's keys, synced-passkey flags; the counter stays 0 for a passkey
that never counted, as synced ones do, else one more than the stored count, which the phone cannot
write back)
and one-time codes (iOS 18+) are all used. New passkeys are not made on the phone: the vault's
writes stay on the Mac, so a passkey registration iOS sends to Walnut gets a screen saying to save
it elsewhere. Saving or changing a password from the phone is not there either; the browser
extension and the Mac do it, and the phone shows the change.

Site matching for the sheet's "Suggested" section is the same host or a parent and child of it,
never two sites under a shared suffix anyone can register under (two `github.io` sites); the full
public suffix list stays on the server, so a miss only means a login is not suggested (search
finds it). Tests: `tests/e2e/vault-sealed.test.ts` (the routes, paging, rekey, a device opening the
vault), `ios-native/WalnutTests/VaultCryptoTests.swift` (a fixture the server's code sealed,
`scripts/ios-vault-fixture.ts`, opened by the phone's code; TOTP, matching, passkey signatures, the
cache, the identities, the extension's build number).

## Agents

Code: `src/core/vault/agent.ts` (the decision `decideAgentUse`, asks, brakes), `agent-grants.ts`,
`agent-log.ts`, `policy.ts`, `pass-cli.ts` (`walnut pass`), `src/web/routes/vault-agent-v1.ts`,
`src/ops/vault.ts`, the `walnut-passwords` skill, and Passwords, Agent Activity in the app.

An agent never holds a vault session. It names an item (its id, name, a site, or an API key's
env var), says why and how it will use it (`use`: `reveal`, the value itself; `env`, given to a
command; a fill into a page from the browser extension), and Walnut decides:

| Switch | Item set to never | Sensitive item | Any other item |
| --- | --- | --- | --- |
| Any (a new vault) | refused | the person approves, with Face ID or Touch ID | given at once |
| Ask | refused | the person approves, with Face ID or Touch ID | the person approves (an item set to "without asking" is given) |
| Off | refused | the person approves, with Face ID or Touch ID | the person approves; agents list nothing |

A grant the person gave earlier (below) lets the use through without asking, except for an item set
to never. The switch is one line in Settings → Passwords and in Agent Activity: "When an agent
asks for a password: Any / Ask / Off" (stored `allow` / `ask` / `off`). A new vault's setup writes
Any (and 48-hour grants) into `policy.json`. A vault with no `policy.json`, or one that does not
open, reads Ask, so a vault set up before Any existed keeps asking; a file an older Walnut wrote
keeps the value it holds. A person who wants both new settings on an older install picks Any here
and 48 hours under "Keep Passwords unlocked"; nothing else is needed. Under Any a reveal is given
without an approval too: that is the person's choice of switch. Under Off an agent's list is empty
(`off: true` with a note) and only an ask that names one item reaches the person; the brakes still
apply. Setup asks only for the master password; "Agents can ask while Passwords is locked" (the
machine key) is under Recovery and advanced in Settings.

A **sensitive** item always asks, with Face ID or Touch ID on a device that signs approvals (a
tap when none is set up yet, and the ask says so). The ask is an approval (`core/approvals/`): a
card on every console window, a system notification, and a push to the phone with Approve and
Deny, naming the item, its sites, the fields, how it will be used, the purpose, the task, the
host, the directory, the command, and how long the yes lasts.

**Grants.** An approval gives that task, in the session that asked, the fields it asked for, for
the use it asked for (`fill`, `env` or `reveal`; a reveal grant covers env and fill too, a fill or
env grant covers only its own use and never a reveal; a grant an older Walnut kept with no use
reads `fill`), for the grant length the person picked ("An approval lasts" in Settings: once, 1 hour, 12 hours, 48
hours (the default), forever = until revoked; `grantMs` in `policy.json`). An agent may ask for
less (`scope: "once"`, `walnut pass ... --once`), never for more. Agent Activity lists every grant
with its task, session, item, fields, use, who approved it and when it ends, each with Revoke (`POST
/api/v1/vault/agent/grants/:id/revoke`, a person only). Lock all and a new master password end
every grant. Grants live in memory, and in `agent-grants.json` (sealed) only while the machine key
is on, so with it on they last across a restart and with it off a restart ends them.

**Approving needs proof only the person has.** A plain tap from this machine is something any
process here could send, an agent knows its own ask's id, and a process here can even make
itself a device token. So an approval that gives an agent a vault item (`guard` on the
approval) is asked with Face ID or Touch ID wherever a device can sign (the iPhone app, the Mac
app), and takes Approve only with that device key's signature, or, for an item that is not
sensitive (and for a sensitive one while no device can sign), from a window that has Passwords
unlocked (its vault session, which only the master password buys). Anything else gets
`403 vault_unlock_needed`, and the card says to unlock Passwords or use the phone. Deny is open
to any answer.

Who asked: a session id counts only from the host that session runs on (`requesterOf` in
`approvals-v1.ts`), so a script on a dev box cannot name another host's session to borrow its
task's grant. Known limit: a process on the Mac itself, as the same user, can name any session
and claim any host (the `x-walnut-origin` header is believed from this machine), so it can use a
grant some task already holds and make its card say another host. It cannot approve an ask.

The switch and the grant length live in `policy.json`, sealed with the vault key, never in
`config.yaml`, which an agent can write. A file that is there but does not open reads Ask, and a
file removed while Walnut runs reads the last value this process saw. A file removed
while Walnut is stopped reads Ask at the next start, never Any. Only a person with the
vault unlocked changes them, in Settings or in Agent Activity.

Brakes, per asker (its task, else its host): at most 3 asks waiting at once, at most 30 uses in
10 minutes, and after 3 denials in 30 minutes its asks pause for 30 minutes. Waiting asks live
in memory; a restart ends them, and Lock all withdraws every waiting ask; an ask nobody waits on
is dropped once its approval runs out. Lock all and every move of the switch also stop a release
still running: an approval that comes back after it gives nothing (`withdrawn`). With the machine
key off, an agent can use the vault only while some window has Passwords unlocked.

**Audit.** Every list, ask, use, refusal, revoke and agent sync goes to `agent-log.json` (newest
500), sealed with the vault key, so item names and purposes stay as private as the vault; it never
holds a value. A use records how (`use`: showed plaintext, gave it to a command, filled it into a
page, listed), the fields, the item, the task and session, the command, and who approved it.
Agent Activity shows them all; the Passwords home shows the latest few.

`walnut pass` (the Mac's CLI and every host's):

```
walnut pass list [words] [--site <url>]
walnut pass get <item> --purpose "<why>" [--field <name>]... [--once]
walnut pass run --purpose "<why>" --env NAME=<item>[:field] [--env <item>]... [--once] -- <command> [args...]
walnut pass sync-bitwarden          # Walnut runs bw itself; nothing is read from stdin
```

`get` asks with `use: reveal`, `run` with `use: env`.

`run` gives the command its secrets as environment variables and replaces each of them (3
characters or more) with `********` in its stdout and stderr, across chunk boundaries, also
URL-encoded, JSON-escaped, inside base64 and line by line for a value that spans lines, so a
secret printed by accident reaches neither the terminal, an agent's context nor a transcript. It
guards against accidents, not against a command set on printing a secret in some other shape.
`password_use` and `pass get` return the value itself, which stays in the session's transcript:
they are for a value the agent must type. While an ask waits `run` says so on stderr; Ctrl-C
withdraws the ask. Exit codes before the command runs: 1 denied or refused, 2 nobody answered,
3 error, 130 stopped; once it runs, the command's own code (128+n for signal n).

## Sync from Bitwarden

Code: `src/core/vault/sources/bitwarden/sync.ts` (the merge), `run.ts` (running `bw`, the daily
timer), `src/web/routes/vault-sync-v1.ts`. One way: Bitwarden is the source, Walnut follows.

Input is an unencrypted Bitwarden JSON export, held in memory only: Walnut never writes it to disk
and never logs it. Walnut runs `bw sync`, then `bw export --format json --raw` itself: from "Sync
now" in Settings, from an agent (`POST /api/v1/vault/sync/bitwarden/run`, the op
`password_sync_bitwarden`, `walnut pass sync-bitwarden`, which reads nothing from stdin), and in the
daily run at 04:00 local time ("Sync from Bitwarden daily" in Settings, `passwords.bitwarden_daily`,
off by default; the primary only). An agent only triggers that run: export text it made could
plant items or trash any linked one, so `POST /api/v1/vault/sync/bitwarden {export}` takes text only
from a person's unlocked window (`403 export_person_only` for any request with a session caller,
the CLI's mark, or no vault session). Walnut runs `bw` in a child process with a timeout and
`BW_NOINTERACTION`, with `BW_SESSION` from its own environment or, on macOS, from the login keychain
item with service `BW_SESSION`; `WALNUT_BW_PATH` names the binary. The vault must be open: only the
daily run unlocks a locked vault from this Mac's keychain (when the item is there); otherwise the
run is skipped and Settings says why. An agent's run is refused while agent access is Off (`403
agents_off`); it is logged in Agent Activity with its counts.

Each Bitwarden item id is linked to one Walnut item in `bitwarden-sync.json` (sealed beside the
vault), with a hash of the fields Bitwarden owns (name, login, sites, notes, fields, card, folder,
favorite). Per item:

- **New in Bitwarden:** added, unless an unlinked Walnut item is the same one (a plain import
  made earlier): same type, title, username and first site, or for a note, card or identity the
  same type and title. That item is adopted: unchanged when its fields match, else updated; it
  keeps its own agent access and sensitive mark. Only a match of exactly one item on each side is
  adopted: with more than one look-alike in Walnut or in the export, the Bitwarden item is added as
  new and counted `ambiguous`.
- **Changed in Bitwarden:** updated, keeping what only Walnut has (agent access, env var name,
  sensitive, passkeys made in Walnut, when it was used); the old password goes into its history.
- **Changed on both sides** (the Walnut copy's Bitwarden-owned fields differ from the last sync,
  or it was moved to the trash): both kept, the Walnut copy tagged `conflict` and no longer
  synced, Bitwarden's added as a new item. A Walnut-only setting is no change.
- **Gone from Bitwarden:** its Walnut item moves to the trash (30 days to restore). An item still
  in the export that does not read (skipped) is not gone: its link and its Walnut copy stay. A sync
  that would trash more than 20% of the linked items, and more than 5, is not run (`409
  sync_mass_trash`, nothing written): the person runs Sync now and confirms, which sends
  `allowMassTrash` (honored only from a person's session; the daily run and agents never send it).

All changes are one vault write. The answer counts added, updated, moved to the trash, conflicts,
unchanged and ambiguous, overall and per type, and the items in the export and linked after the sync per
type, so a person can see every item came across. Identities come in as items with custom fields
(SSN, passport and license hidden); SSH keys are skipped. `GET /api/v1/vault/sync/bitwarden`
answers the daily switch and the last run.
