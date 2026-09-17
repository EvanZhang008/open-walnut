# macOS session identity

On macOS, agent sessions are attributed to **Walnut**, the app you already have,
rather than to the `node` binary that started the server. This page explains what
that changes, what to grant, and what it does not do.

## The problem it solves

macOS attributes a file access to the *responsible process*, which is inherited at
spawn time from the top of the launcher chain.

When `Walnut.app` starts the server, that chain already ends at Walnut: the
server, the session daemon, the `claude` CLI and every tool the CLI runs are all
attributed to Walnut, and nothing here is needed. The gap is a server started from
a **terminal** (`npm run dev:prod`), which makes the `node` binary responsible for
the whole subtree. Three results:

- The permission dialog said `"node" would like to access data from other apps`,
  naming a shared runtime rather than what was actually asking.
- The grant belonged to that node build, so a `brew upgrade node` threw it away,
  and every other node program on the machine shared it.
- The automatic app-container permission lasts only while the granted app keeps
  running ([WWDC23 session 10053](https://developer.apple.com/videos/play/wwdc2023/10053/)),
  so the chain's short-lived processes kept asking again.

## What happens now

Walnut launches the daemon through itself: `Walnut --session-host -- <daemon> …`.
The app makes itself the responsible process, then starts the daemon, so
everything below it (daemon, shell, `claude`, tools) is attributed to Walnut no
matter who started the server.

| | Before | Now |
|---|---|---|
| Dialog names | the `node` binary | Walnut |
| Grant survives a node upgrade | no | yes |
| Shared with other node programs | yes | no |
| Rows in Privacy & Security | one per launcher | one, for Walnut |

Deliberately **not** a second bundle: a separate "sessions" identity would mean
another row in System Settings for something you think of as one app.

The path to add in System Settings is the app itself:

```
/Applications/Walnut.app
```

To stop seeing the app-data dialog at all, add Walnut to **System Settings →
Privacy & Security → Full Disk Access**. That is a deliberate choice, not a
requirement: ordinary work in your own project directories needs no grant, and
sessions keep working if you skip it, deny it, or revoke it later. Note that this
grant covers the app as a whole, so it does not separate the UI from the sessions.

You do not have to find that path yourself. Walnut's **Settings → macOS Access**
has an optional *Session file access* row: **Set up…** explains what the grant
buys, opens the right pane, and copies the path to your clipboard, so the whole
setup is a paste. The row keeps saying "Can't be checked" afterwards, because
macOS offers no way to read this grant back; the observable signal is that the
popups stop.

## Scope, precisely

- **Full Disk Access granted to Walnut covers the daemon and everything it
  starts**, not one particular tool call. It settles *which identity* holds the
  permission; it is not a sandbox and does not narrow what a session can read.
- Sessions already running keep the attribution they were started with. The new
  identity applies to processes started after the daemon next restarts; Walnut does
  not kill live sessions to migrate them.
- The terminal + browser setup and the Mac app share one daemon, so they share one
  session identity. Nothing depends on keeping the desktop app open: it is used as
  a signed executable, not as a running UI, and a supervised launch has no window
  and no Dock icon.

## Requirements and other platforms

- Needs a `Walnut.app` that knows the flag, looked for at `/Applications`, then
  `~/Applications`, then a repo checkout's `desktop/Walnut.app`. Support is
  detected by reading the binary, never by running it, because an older app handed
  an unknown flag would ignore it and open a window. An older app is reported in
  the log with the command to rebuild it, and the daemon runs under the plain
  identity meanwhile.
- **Rebuild with `desktop/build.sh`, not `desktop/build-release.sh`.** The release
  script ad-hoc signs when the machine has no Developer ID Application certificate,
  and an ad-hoc signature gives tccd a content-hash identity that changes on every
  rebuild, so each rebuild would ask for the grant again. `build.sh` signs with the
  Apple Development certificate, which keeps one stable identity
  (`com.local.walnut-desktop` plus the team) across rebuilds. Check before
  installing over an existing app: `codesign -dv --verbose=2 <app>` must report the
  same `Identifier` and `Authority` as the app being replaced, or the grant is lost.
- An npm or terminal-only install with no `Walnut.app` keeps the plain node
  identity. Nothing is installed and no bundle is built to change that.
- Linux hosts (local or over SSH) keep the existing daemon and ordinary filesystem
  permissions: no bundle, no Apple signing, no TCC. Which mechanism applies is
  decided by the machine the session *runs on*, not by the client you use. Driving
  a Linux session from a Mac browser still uses Linux permissions. Running
  `claude` yourself in a terminal, without Walnut, is unaffected.

## Operational notes

- Anything wrong (no app, an app too old to know the flag, not macOS) falls back to
  starting the daemon directly and logs an error. An identity improvement must
  never be able to take local sessions down.
- One case deliberately does not fall back: the app is still running as a
  supervisor but no daemon has published its port. Walnut then fails with a message
  naming it instead of starting a second daemon, because the first one may be
  seconds from coming up and two daemons against one runtime dir is the worse
  outcome. The message points at `daemon-stderr.log` and at the switch below.
- Turn it off with `WALNUT_SESSION_HOST=0`.
- Test and sandbox daemons deliberately do not use it, so a test run can never
  borrow a granted identity or put a permission dialog on screen.
- Walnut runs only the command recorded in
  `~/Library/Application Support/Open Walnut/session-host-launch.json`, and
  re-checks the payload's hash before starting it. That file is owned by you and
  mode 0600, which stops other software from reusing the app as a launcher. Code
  running as your own user could rewrite it, so it is not a defence against
  same-user malware.

Implementation: `desktop/SessionHost.swift` (the supervisor, called by
`desktop/main.swift` before any UI exists), `src/providers/session-host.ts` (find
the app, approve the command), `src/providers/session-host-core.ts` (paths,
manifest, launch decision).
