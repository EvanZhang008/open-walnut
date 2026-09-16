# macOS session identity (Walnut Sessions)

On macOS, agent sessions run under a small signed bundle called **Walnut Sessions**
instead of under the `node` binary that started Walnut. This page explains what
that changes, what to grant, and what it does not do.

## The problem it solves

macOS attributes a file access to the *responsible process*, which is inherited at
spawn time from the top of the launcher chain. Walnut's server is
`node dist/cli.js web`, so the session daemon, the `claude` CLI under it, and every
tool the CLI runs all inherited that `node` binary. Three results:

- The permission dialog said `"node" would like to access data from other apps`,
  naming a shared runtime rather than what was actually asking.
- The grant belonged to that node build, so a `brew upgrade node` threw it away,
  and every other node program on the machine shared it.
- The automatic app-container permission lasts only while the granted app keeps
  running ([WWDC23 session 10053](https://developer.apple.com/videos/play/wwdc2023/10053/)),
  so the chain's short-lived processes kept asking again.

## What happens now

The daemon is started by `Walnut Sessions.app`, which makes itself the responsible
process first. Everything below it (daemon, shell, `claude`, tools) is attributed
to that one bundle, which lives as long as the daemon does.

| | Before | Now |
|---|---|---|
| Dialog names | the `node` binary | Walnut Sessions |
| Grant survives a node upgrade | no | yes |
| Shared with other node programs | yes | no |
| Grant lasts | while each short-lived process ran | while the daemon runs |

Installed at, and this is the path to add in System Settings:

```
~/Library/Application Support/Open Walnut/Walnut Sessions.app
```

To stop seeing the app-data dialog at all, add that bundle to **System Settings →
Privacy & Security → Full Disk Access**. That is a deliberate choice, not a
requirement: ordinary work in your own project directories needs no grant, and
sessions keep working if you skip it, deny it, or revoke it later.

## Scope, precisely

- **Full Disk Access granted to this bundle covers the daemon and everything it
  starts**, not one particular tool call. It separates *which identity* holds the
  permission; it is not a sandbox and does not narrow what a session can read.
- Sessions already running keep the attribution they were started with. The new
  identity applies to processes started after the daemon next restarts; Walnut does
  not kill live sessions to migrate them.
- `Walnut.app` (the desktop wrapper) and the terminal + browser setup share the
  same daemon and therefore the same session identity. Nothing depends on opening
  the desktop app.

## Other platforms

Linux hosts (local or over SSH) keep the existing daemon and ordinary filesystem
permissions: no bundle, no Apple signing, no TCC. Which mechanism applies is
decided by the machine the session *runs on*, not by the client you use — driving a
Linux session from a Mac browser still uses Linux permissions. Running `claude`
yourself in a terminal, without Walnut, is unaffected.

## Operational notes

- Built and signed on demand on first daemon start, then reused. It is **never**
  rebuilt while its source is unchanged: the code identity is what the grant is
  remembered against, so a pointless rebuild would silently discard it.
- Needs the Xcode Command Line Tools for that one-time compile, same as the
  calendar and Screen Time helpers. Without them the daemon runs under the plain
  identity and says so in the log.
- Anything wrong with the host (no compiler, a refused launch) falls back to
  starting the daemon directly and logs an error. An identity improvement must
  never be able to take local sessions down.
- Turn it off with `WALNUT_SESSION_HOST=0`.
- Test and sandbox daemons deliberately do not use it, so a test run can never
  install a granted identity or put a permission dialog on screen.
- The host runs only the command recorded in
  `~/Library/Application Support/Open Walnut/session-host-launch.json`, and
  re-checks the payload's hash before starting it. That file is owned by you and
  mode 0600 — it stops other software from reusing the host, but code running as
  your own user could rewrite it, so it is not a defence against same-user malware.

Implementation: `src/data/walnut-sessions.swift` (the supervisor),
`src/providers/session-host.ts` (build, sign, install, approve),
`src/providers/session-host-core.ts` (paths, manifest, launch decision).
