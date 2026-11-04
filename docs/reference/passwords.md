# Passwords

Walnut keeps a password vault on the machine that runs the Walnut server (the Mac, the
leader). The web console and the Mac app have a Passwords app; the browser extension, the
iPhone app and agents come in later steps and use the same vault.

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
| `vault.json` | ciphertext only: the KDF parameters, the wrapped vault key, every item sealed |
| `machine.json` (0600) | the Secret Key, and the machine key while "agents may ask while you are away" is on |
| `backups/vault-<date>.json` | the previous `vault.json`, one per day, newest 14 |

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
password buys (`POST /api/v1/vault/unlock`). Sessions live in memory: a restart locks every
window. A session ends after `passwords.auto_lock_minutes` unused (default 15), after 12
hours whatever happens, or on Lock / Lock all; the one-time code refreshing by itself does
not count as use. Wrong passwords: five free, then each try waits twice as long as the last
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

## Who may open it

A person only: no session caller (`x-walnut-caller-sid`), no CLI automation mark, this
machine or a paired device, the approvals rule. Agents never get a vault session; they use
the vault through their own ops, each use gated by the item's agent access and a person's
approval. A test run may read the status and nothing else. The cloud companion never carries
these calls (`/vault` is in its kept routes, `src/web/v1-forward/policy.ts`), because it
would see them in the clear between its TLS and the bridge, and a follower answers
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
session, kept in `storage.session` (memory only, gone when the browser quits, closed to
content scripts). It derives the password key with WebCrypto, after checking the KDF the
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

**What lives where.** The background holds the device token (its IndexedDB, which content
scripts cannot open), the vault session and, for 5 s while unlocked, the item summaries (so a
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

**Agents in the browser.** The same extension can let Walnut agents work in tabs of their own, on sites the person approves; it is off until they turn it on in the popup. See [Agents in your browser](browser-control.md).

## Agents

Code: `src/core/vault/agent.ts` (policy, asks, grants, brakes), `agent-log.ts`, `policy.ts`,
`pass-cli.ts` (`walnut pass`), `src/web/routes/vault-agent-v1.ts`, `src/ops/vault.ts`, the
`walnut-passwords` skill, and Passwords, Agent Activity in the app.

An agent never holds a vault session. It names an item (its id, name, a site, or an API key's
env var) and says why, and Walnut decides:

| | Item set to never | Item set to ask (default) | Item set to without asking |
| --- | --- | --- | --- |
| Never | refused | refused | refused |
| Ask me first | refused | the person approves | given |
| Give it without asking | refused | given | given |

The switch is one sentence in Settings → Passwords and in Agent Activity: "When an agent asks
for a password: Ask me first / Give it without asking / Never" (stored `ask` / `allow` / `off`).
Setup asks only for the master password; "Agents can ask while Passwords is locked" (the machine
key) is under Recovery and advanced in Settings.

A **sensitive** item always asks, with Face ID or Touch ID on a device that signs approvals (a
tap when none is set up yet, and the ask says so). The ask is an approval (`core/approvals/`): a
card on every console window, a system notification, and a push to the phone with Approve and
Deny, naming the item, its sites, the fields, the purpose, the task, the host, the directory and
the command. One approval lets one use through; an agent may ask `scope: "task"`, which gives
that task, in the session that asked, the fields it asked for, for an hour.

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

The switch lives in `policy.json`, sealed with the vault key, never in `config.yaml`, which an
agent can write; a missing or tampered file reads "ask each time" (never "without asking"). Only a person with the vault
unlocked changes it, in Settings or in Agent Activity.

Brakes, per asker (its task, else its host): at most 3 asks waiting at once, at most 30 uses in
10 minutes, and after 3 denials in 30 minutes its asks pause for 30 minutes. Grants and waiting
asks live in memory; a restart ends them, and Lock all ends every grant and withdraws every
waiting ask; an ask nobody waits on is dropped once its approval runs out. Lock all and every move
of the switch also stop a release still running: an approval that comes back after it gives
nothing (`withdrawn`). With the machine key off, an agent can use the vault only while some window has
Passwords unlocked.

Every ask, use and refusal goes to `agent-log.json` (newest 500), sealed with the vault key, so
item names and purposes stay as private as the vault; it never holds a value.

`walnut pass` (the Mac's CLI and every host's):

```
walnut pass list [words] [--site <url>]
walnut pass get <item> --purpose "<why>" [--field <name>]... [--task]
walnut pass run --purpose "<why>" --env NAME=<item>[:field] [--env <item>]... [--task] -- <command> [args...]
```

`run` gives the command its secrets as environment variables and replaces each of them (3
characters or more) with `********` in its stdout and stderr, across chunk boundaries, also
URL-encoded, JSON-escaped, inside base64 and line by line for a value that spans lines, so a
secret printed by accident reaches neither the terminal, an agent's context nor a transcript. It
guards against accidents, not against a command set on printing a secret in some other shape.
`password_use` and `pass get` return the value itself, which stays in the session's transcript:
they are for a value the agent must type. While an ask waits `run` says so on stderr; Ctrl-C
withdraws the ask. Exit codes before the command runs: 1 denied or refused, 2 nobody answered,
3 error, 130 stopped; once it runs, the command's own code (128+n for signal n).
