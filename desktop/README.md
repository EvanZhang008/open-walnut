# Walnut Desktop App

A tiny native macOS wrapper (Swift + AppKit + WebKit) that runs Open Walnut as a
real desktop app instead of a browser tab. It bootstraps the source, starts the
local server, and shows the web console in a `WKWebView` window.

It's deliberately thin — **all** the product lives in the main Open Walnut
codebase. This wrapper only:

- On first launch, offers to **download and set up** Walnut automatically
  (clone → `npm install` → build server + web), or point at an existing
  `~/.open-walnut` install.
- Locates a suitable **Node.js** (mise / nvm / fnm / Homebrew / system, newest
  first, requires **Node 20+**) and **Git**.
- Starts the server (`dist/cli.js web`) on port **3456** (falls back to 4567),
  reclaiming a stale server orphaned by a previous crash, and loads
  `http://localhost:<port>` in the window.
- Cleanly stops the server it started when you quit.

## Requirements

- macOS 12+ (Monterey or newer)
- **Xcode Command Line Tools** — provides `swiftc` to build and `git`:
  `xcode-select --install`
- **Node.js 20+** — via [mise](https://mise.jdx.dev), `nvm`, `fnm`, or
  [Homebrew](https://brew.sh) (`brew install node`)

## Build

Two scripts, same output bundle (`Walnut.app` in this directory):

```bash
# Fast, native-arch build — best for local development / testing
./build.sh

# Distributable: universal binary (arm64 + x86_64), ad-hoc signed, + Walnut.dmg
./build-release.sh
```

Then either launch it in place or install it:

```bash
open Walnut.app                 # run from here
cp -r Walnut.app ~/Applications # or install for the current user
```

`build-release.sh` additionally produces `Walnut.dmg` — a drag-to-Applications
disk image you can hand to other users.

## First run

Because the app is **ad-hoc signed** (no paid Apple Developer ID), Gatekeeper
will warn the first time. Right-click `Walnut.app` → **Open** → **Open**, or:

```bash
xattr -dr com.apple.quarantine Walnut.app
```

On first launch pick **Get Started** to auto-download and build Walnut into
`~/.open-walnut`, or **Use Existing Installation** to point at a directory you
already have. Setup takes a couple of minutes the first time (npm install +
build); subsequent launches start instantly.

## How it works

`main.swift` is the whole app (one file, AppKit). Key pieces:

- **Setup / bootstrap** — clones `https://github.com/EvanZhang008/open-walnut.git`,
  runs `npm install`, then builds the CLI/server (`tsup`) and web UI (`vite`)
  directly (skips the `bun`-only daemon cross-compile the desktop app doesn't
  need). Progress and a full `bootstrap.log` land in
  `~/Library/Application Support/Walnut/`.
- **Server lifecycle** — spawns `node dist/cli.js web --port <port>` with
  `OPEN_WALNUT_EXIT_ON_ORPHAN=1` so the server self-terminates if the app dies
  uncleanly (no port left held). Detects an already-running server and only
  reclaims it if it's an *orphaned* Walnut process (parent PID 1).
- **Window** — a `WKWebView` pointed at `http://localhost:<port>`; external
  links open in the default browser.

Config (chosen home + source dir) is stored at
`~/Library/Application Support/Walnut/config.json`. Use **Reset Setup…** from the
app menu to start over.

## Notes

- Bundle identifier: `com.local.walnut-desktop`.
- This wrapper is macOS-only. Other platforms run Walnut via the CLI
  (`open-walnut web`) and a browser.
