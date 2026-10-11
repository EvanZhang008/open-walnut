# Walnut Desktop App

A tiny native macOS wrapper (Swift + AppKit + WebKit) that runs Open Walnut as a
real desktop app instead of a browser tab. It installs Walnut on first launch,
starts the local server, and shows the web console in a `WKWebView` window.

It's deliberately thin — **all** the product lives in the main Open Walnut
codebase. This wrapper only:

- On first launch it installs the self-contained Walnut by itself (its own
  Node inside) with the `install.sh` it carries in `Contents/Resources`, the same
  script `curl … | sh` runs, into `~/.local/share/open-walnut` (also linking
  `walnut` into `~/.local/bin`). A release's app carries that Walnut too
  (`Contents/Resources/release/`, one DMG per Mac architecture; a signed build
  signs every binary inside that archive too, since notarization looks inside
  it), so this takes a few seconds and no network; one without it for this Mac
  downloads it (about
  300 MB, with a progress bar). Nothing else needs to be installed. That copy
  updates itself; the app is never modified.
  Or point it at an existing `~/.open-walnut` install or a source checkout.
- For a source checkout, locates a suitable **Node.js** (mise / nvm / fnm /
  Homebrew / system, newest first, requires **Node 22+**) and **Git**.
- Starts the server (`dist/cli.js web`) on port **3456** (falls back to 4567),
  reclaiming a stale server orphaned by a previous crash, and loads
  `http://localhost:<port>` in the window.
- Restarts an owned server automatically after an unexpected exit, with bounded
  backoff to prevent a crash loop.
- Cleanly stops the server it started when you quit.

## Requirements

- macOS 12+ (Monterey or newer)
- To build it: **Xcode Command Line Tools** (`swiftc`): `xcode-select --install`
- To run it from a source checkout: **Node.js 22+**, via [mise](https://mise.jdx.dev),
  `nvm`, `fnm`, or [Homebrew](https://brew.sh) (`brew install node`). The
  downloaded app needs neither.

## Build

Two scripts, same output bundle (`Walnut.app` in this directory):

```bash
# Fast, native-arch build — best for local development / testing
./build.sh

# Distributable: universal binary (arm64 + x86_64) + Walnut.dmg
./build-release.sh

# A release's: carries that release's archive for one Mac, + Walnut-<arch>.dmg
WALNUT_APP_VERSION=0.7.0 WALNUT_APP_RUNTIME=open-walnut-0.7.0-darwin-arm64.tar.gz \
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

`main.swift` is the whole app (one file, AppKit). Key pieces:

- **Setup**: a first launch runs the bundled `install.sh` (`BundledRuntime.swift`)
  on the release the app carries for this Mac, as a `file://` base, or else on
  the GitHub release (reading the download's percentage off its progress bar),
  and the server then
  runs on that copy's own Node. **Set Up Now** (from Use
  Existing, for a folder with no build) clones
  `https://github.com/EvanZhang008/open-walnut.git`, runs `npm install`, then
  builds the CLI/server (`tsup`) and web UI (`vite`) directly. Progress and a full
  `bootstrap.log` land in `~/Library/Application Support/Walnut/`; Retry runs
  the setup that failed again.
- **Server lifecycle** — spawns `node dist/cli.js web --port <port>` with
  `OPEN_WALNUT_EXIT_ON_ORPHAN=1` so the server self-terminates if the app dies
  uncleanly (no port left held). Detects an already-running server and only
  reclaims it if it's an *orphaned* Walnut process (parent PID 1).
- **Window** — a `WKWebView` pointed at `http://localhost:<port>`; external
  links open in the default browser.

Config (chosen home, source dir and, for the self-contained copy, its install
dir) is stored at `~/Library/Application Support/Walnut/config.json`. Use **Reset Setup…** from the
app menu to start over.

Desktop lifecycle events are written as JSON lines to
`~/Library/Application Support/Walnut/desktop.log`. The log rotates at 1 MB
and keeps one previous copy.

Test knobs (environment): `WALNUT_DESKTOP_PORTS` (comma-separated, instead of
3456 and 4567) and install.sh's own `OPEN_WALNUT_*` knobs, which pass through.
`scripts/desktop-smoke.mjs` uses them with a throwaway `HOME` and
`CFFIXED_USER_HOME` (which `NSHomeDirectory()` follows) to launch a built app
the way a new Mac would; CI's macOS release rehearsal runs it on every push.

## Notes

- Bundle identifier: `com.local.walnut-desktop`.
- This wrapper is macOS-only. Other platforms run Walnut via the CLI
  (`open-walnut web`) and a browser.
