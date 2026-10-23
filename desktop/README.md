# Walnut Desktop App

A tiny native macOS wrapper (Swift + AppKit + WebKit) that runs Open Walnut as a
real desktop app instead of a browser tab. It installs Walnut on first launch,
starts the local server, and shows the web console in a `WKWebView` window.

It's deliberately thin — **all** the product lives in the main Open Walnut
codebase. This wrapper only:

- On first launch it installs Walnut by itself, the compiled file with
  everything inside, with the `install.sh` it carries in `Contents/Resources`,
  the same script `curl … | sh` runs, into `~/.local/share/open-walnut`
  (`versions/<version>/walnut`, with `walnut` linked into `~/.local/bin`). A
  release's app carries that file too (`Contents/Resources/release/`, one DMG
  per Mac architecture, signed with the app's identity and the hardened runtime
  with `walnut-file.entitlements`, since notarization looks at every binary in
  the app), so this takes a few seconds and no network; one without it for
  this Mac downloads it (with a progress bar). Nothing else needs to be
  installed. That copy also updates itself in place. A Mac that still has the
  Node archive an older app installed keeps running it until the next app
  update installs the file over it.
- Updates itself the way T3 Code's app does: a quiet check 15 seconds after
  launch and every 4 minutes, an update item in the sidebar once there is one,
  a download you start, and **Restart to update** (see [Updates](#updates)).
  Or point it at an existing `~/.open-walnut` install or a source checkout.
- For a source checkout, finds **bun** (PATH, `~/.bun/bin`, Homebrew, `/usr/local/bin`),
  at least the version the checkout's `package.json` pins.
- Starts the server (`walnut web`, or `bun dist/cli.js web` for a checkout) on port **3456** (falls back to 4567),
  reclaiming a stale server orphaned by a previous crash, and loads
  `http://localhost:<port>` in the window.
- Restarts an owned server automatically after an unexpected exit, with bounded
  backoff to prevent a crash loop.
- Cleanly stops the server it started when you quit.

## Requirements

- macOS 12+ (Monterey or newer)
- To build it: **Xcode Command Line Tools** (`swiftc`): `xcode-select --install`
- To run it from a source checkout: **bun**, at least the version its `package.json`
  pins (`curl -fsSL https://bun.sh/install | bash`), and a build (`bun install`,
  `bun run web:build`). The downloaded app needs nothing else.

## Build

Two scripts, same output bundle (`Walnut.app` in this directory):

```bash
# Fast, native-arch build — best for local development / testing
./build.sh

# Distributable: universal binary (arm64 + x86_64) + Walnut.dmg
./build-release.sh

# A release's: carries that release's file for one Mac, + Walnut-<arch>.dmg
WALNUT_APP_VERSION=0.7.0 WALNUT_APP_RUNTIME=walnut-0.7.0-darwin-arm64.gz \
  WALNUT_APP_RUNTIME_SUMS=SHA256SUMS ./build-release.sh
```

### Signing

The two scripts deliberately accept different identities:

- `build.sh` (local) takes any certificate, **Developer ID or Apple Development**. A stable signing identity is what makes macOS remember permission grants (the microphone prompt), so a plain rebuild does not re-prompt. Ad-hoc identities change every build, which re-prompts every time.
- `build-release.sh` (for other people) takes **only Developer ID Application**, and falls back to ad-hoc otherwise. An Apple Development certificate is worthless to recipients (Gatekeeper does not trust it for distribution) and actively dangerous: it expires yearly, and an expired or revoked identity makes the app refuse to launch behind a misleading "you can't use this version of the application" alert. Ad-hoc never expires, so it is the safer fallback.
- Both scripts assess the signature after applying it and move to the next identity when the certificate itself is untrusted (revoked or expired).

For a warning-free first run for other users the app must be signed with a
Developer ID, with the hardened runtime and `Walnut.entitlements` (the microphone
and the calendar, which the hardened runtime withholds otherwise), and notarized.
`build-release.sh` does all of it when told how:

```bash
WALNUT_SIGN_IDENTITY="Developer ID Application: …" \
WALNUT_NOTARY_KEY=AuthKey_XXXX.p8 WALNUT_NOTARY_KEY_ID=XXXX WALNUT_NOTARY_ISSUER=<issuer-id> \
  ./build-release.sh   # signs, notarizes and staples the app, then the DMG
```

Releases do this in GitHub Actions (`.github/workflows/mac-app.yml`, called by
`release-archives.yml` once the archives are attached): the identity and an App
Store Connect API key live only in the repository's `release` environment, go
into a keychain made for the job, and each DMG (`Walnut-arm64.dmg`,
`Walnut-x64.dmg`) is attached only after Gatekeeper accepts it as a browser
download and its first launch has installed that release and served the console
(`scripts/desktop-smoke.mjs`; the Apple silicon one from what it carries, with no
network).

Then either launch it in place or install it:

```bash
open Walnut.app                 # run from here
cp -r Walnut.app ~/Applications # or install for the current user
```

`build-release.sh` additionally produces `Walnut.dmg` (or `Walnut-<arch>.dmg`
when it carries a release): a drag-to-Applications disk image you can hand to
other users.

## First run

A build that was not signed with a Developer ID and notarized (see
[Signing](#signing)) makes Gatekeeper warn the first time. Right-click
`Walnut.app` → **Open** → **Open**, or:

```bash
xattr -dr com.apple.quarantine Walnut.app
```

On first launch the app installs the self-contained Walnut by itself and opens
the console; nothing to click. A release's DMG carries it (a few seconds, no
network); a build without it for this Mac downloads it (a minute or so, with a
progress bar).
**Use an existing installation instead…** on that screen points it at a
directory you already have (a `~/.open-walnut` with a built `source/`, or a dev
checkout); the download stops only once a folder is picked. A Mac where
`install.sh` already ran uses that copy without downloading. Subsequent launches
start instantly. **Reset Setup…** (app menu) shows the choice again.

## How it works

`main.swift` is the app (AppKit), with a few files beside it. Key pieces:

- **Setup**: a first launch runs the bundled `install.sh` (`BundledRuntime.swift`)
  on the release the app carries for this Mac, as a `file://` base, or else on
  the GitHub release (reading the download's percentage off its progress bar),
  and the server then
  runs as that copy's `bin/walnut` link, so a restart after an update runs the
  new version (an older Node archive: on its own Node). **Set Up Now** (from Use
  Existing, for a folder with no Walnut yet) installs the same self-contained
  Walnut with its data in that folder. A setup an older app made there as an npm
  checkout (`<folder>/source`) moves to it on the next launch and keeps its data.
  Progress and a full `bootstrap.log` land in
  `~/Library/Application Support/Walnut/`; Retry runs the setup that failed again.
- **Server lifecycle**: spawns `walnut web --port <port>` (a checkout: `bun dist/cli.js web --port <port>`) with
  `OPEN_WALNUT_EXIT_ON_ORPHAN=1` so the server self-terminates if the app dies
  uncleanly (no port left held). Detects an already-running server and only
  reclaims it if it's an *orphaned* Walnut process (parent PID 1).
- **Window** — a `WKWebView` pointed at `http://localhost:<port>`; external
  links open in the default browser.
- **Links** (`AppLink.swift`): the app registers `open-walnut://`, so a plugin
  install link (`open-walnut://install-plugin?url=<git url>`) clicked in a
  browser or a chat app opens Walnut on the Plugin Store with an "Install from a
  link" card. The app only hands the link to the page; nothing installs until the
  person turns on the trust switch and presses Install.
- **The `walnut` command** (`CommandLineTool.swift`): when no `walnut` is on the
  login shell's PATH, the app links `~/.local/bin/walnut` to the Walnut it runs
  and, if that folder is not on PATH, adds one marked line to `~/.zprofile` or
  `~/.bash_profile`. A `walnut` the user already has is never replaced. Walnut >
  Install 'walnut' Command runs the same check and says what it did.

## Updates

The app updates itself as a whole, T3 Code's flow (`AppUpdater.swift`, with
the state and its rules in `AppUpdateMachine.swift`, a port of T3's
`updateMachine.ts`):

1. **Check.** 15 seconds after launch, then every 4 minutes, the app asks the
   releases page for the newest release (`releases/latest`, the redirect to its
   tag; no API call, so no rate limit) and whether that release has a DMG for
   this Mac yet. Nothing shows while there is nothing to do.
2. **Download.** A small notice at the bottom of the window says "Walnut update
   available · Download"; **Check for Updates…** in the app menu and the row in
   Settings → General do the same. A click downloads `Walnut-<arch>.dmg` (a ring fills as
   it comes in), copies the app out of it and checks that the new app is valid
   and satisfies the running app's designated requirement: only a build signed
   by the same developer, with the same bundle id and the expected version, can
   replace it. A failed download offers a retry.
3. **Restart to update.** The same notice then says "Walnut updated · Restart".
   A click restarts at once unless something in an app window would be lost: a
   message typed in a session box is saved and comes back, so it never holds the
   restart; text in other boxes, an attached image, unsaved file edits or a note
   still saving are listed with the window and session they are in, a **Go
   there** button each, and **Restart Anyway** (`web/src/utils/unsaved-work.ts`,
   the `unsavedWindows` request in `AppUpdateBridge.swift`). A build installed
   over the running app (`--desktop-update-bridge`) gets the same notice and the
   same rule. Then the app stops its server
   (5 seconds at most), hands the swap to `apply-update.sh` and quits. The
   script waits for the app to exit, swaps the new app into place with two
   renames (the old one comes back if anything fails) and opens it. Sessions
   run in the session daemon, so they keep going across the restart.
4. **The Walnut inside.** The new app carries the new release's Walnut. On its
   first launch it installs that copy over the older one before the server
   starts (offline, a few seconds), and never over a newer one (a runtime that
   updated itself, or follows the nightly channel, keeps its own).
5. **Walnut's own updates.** Between app updates, the self-contained Walnut
   updates itself while its server runs, never before it listens: the app
   starts the server with `WALNUT_LAUNCHER_UPDATES=1` (a download before listen
   would count against the app's startup deadline, and the restart after it
   would be a process the app does not know), and once the server answers it
   runs `walnut update --auto` once in the background (`runtime_update_*` in
   desktop.log). It keeps `updates.auto: false` and a version held back after
   a failed start; the next server start runs the new version.

Updates are off in a build with no feed (`build.sh`; a release build names the
GitHub releases page in Info.plist as `WalnutUpdateFeed`), in an ad-hoc signed
build, with `WALNUT_DISABLE_AUTO_UPDATE=1`, and in an app that runs from the DMG
or from App Translocation (move it to Applications). Downloads are kept in
`~/Library/Caches/Walnut/Updates`. Test knobs: `WALNUT_UPDATE_FEED_URL`,
`WALNUT_UPDATE_STARTUP_DELAY_MS`, `WALNUT_UPDATE_POLL_MS`; and
`scripts/desktop-update-e2e.mjs` runs the whole flow between two local builds
signed with the same identity, with a local releases page and the page's own
update item clicked by the app (`WALNUT_DESKTOP_E2E_UPDATE_CLICKS=1`).

Config (chosen home, source dir and, for the self-contained copy, its install
dir) is stored at `~/Library/Application Support/Walnut/config.json`. Use **Reset Setup…** from the
app menu to start over.

Desktop lifecycle events are written as JSON lines to
`~/Library/Application Support/Walnut/desktop.log`. The log rotates at 1 MB
and keeps one previous copy.

Test knobs (environment): `WALNUT_DESKTOP_PORTS` (comma-separated, instead of
3456 and 4567) and install.sh's own `OPEN_WALNUT_*` knobs, which pass through.
For the restart of an installed update on a Mac where the real app keeps running:
`WALNUT_DESKTOP_E2E_BACKGROUND=1` opens the window behind every other window without
taking focus, and keeps its page running though covered; `WALNUT_DESKTOP_UPDATE_APP=<path to .app>` lets an isolated daemon
(an ephemeral server's) offer that copy's update, which no isolated daemon does
otherwise; `WALNUT_APPLY_UPDATE_OPEN` (also apply-update.sh's) is the program the
restart helper runs with the app's path to open it again, so the new copy starts
with the test's environment. The copy needs its own bundle identifier: the helper
only restarts an app when exactly one with that identifier is running.
`WALNUT_DESKTOP_E2E_SCRIPT=<file>` adds that script to the main window's console
page, for a test's own steps (typing a draft, reading what the page shows).
`scripts/desktop-smoke.mjs` uses them with a throwaway `HOME` and
`CFFIXED_USER_HOME` (which `NSHomeDirectory()` follows) to launch a built app
the way a new Mac would; CI's macOS release rehearsal runs it on every push.

## Notes

- Bundle identifier: `com.local.walnut-desktop`.
- This wrapper is macOS-only. Other platforms run Walnut via the CLI
  (`open-walnut web`) and a browser.
