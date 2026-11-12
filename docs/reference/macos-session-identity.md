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
a **terminal** (`bun run dev:prod`). When the server ran on Node, that made the `node`
binary responsible for the whole subtree. Three results:

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
has a *Full Disk Access* row: **Set up…** explains what the grant buys, opens the
right pane, and copies the path to your clipboard, so the whole setup is a paste.
With no feature that reads protected files switched on, the row is optional and
keeps saying "Can't be checked" afterwards, because macOS offers no way to read
this grant back; the observable signal is that the popups stop. With one switched
on (see below), the row checks the grant through that feature's own file.

## Calendar follows the same rule

Calendar requests go to the same app: `Walnut --calendar-bridge <subcommand> …`
answers one EventKit request and exits (no window, no Dock icon). So System
Settings → Privacy & Security → Calendars shows **Walnut**, one certificate-signed
identity that keeps its grant across rebuilds.

Before this, a separate `walnut-calendar-v<N>` helper asked for itself, and every
version bump was a new program to macOS that asked again. The helper remains for
installs with no Walnut.app. While Walnut has not been granted yet, a helper you
granted earlier keeps the calendar full, and Settings says so.

Moving to Walnut costs one more Calendars prompt, naming Walnut. It is the last one.

## So does every other protected read

Files macOS keeps behind Full Disk Access (the Screen Time store, the Focus state
in `~/Library/DoNotDisturb/DB/`) are read by `Walnut --reader-bridge read|probe
<path>`, the same small read-only program as the `walnut-reader` helper compiled
into the app. So the grant that stops the session popups is also the one these
features use, and System Settings → Full Disk Access lists **Walnut**, once.
Plugins read the same way (`walnut.macos.readProtectedFile`, after saying why with
`walnut.macos.useFullDiskAccess`), and the Settings row names every reason the
grant is used for.

Full Disk Access never shows a dialog: a read without it fails with "Operation not
permitted" and nothing appears on screen. The `walnut-reader` helper remains for
installs with no Walnut.app. While Walnut has no Full Disk Access yet, a helper you
granted earlier keeps reading, and Settings shows the row as working through it.

One store is walled beyond this grant on macOS 26: the Screen Time database
refuses even a process that holds Full Disk Access (an MDM security agent with the
grant is denied the same directory). The row therefore judges the grant by every
protected file in use together: while another one reads fine (the Focus state, for
example), a Screen Time refusal does not send you to add a program that is already
added.

## Local Network, and the server a deploy runs

macOS asks "Allow ... to find devices on local networks?" the first time a program
reaches a local address (an SSH host on your LAN, a machine joined to Walnut). For an
app the answer is kept under its bundle, so Walnut.app is asked once. For a program
with no bundle, macOS keeps the answer under the program's **path** and its Mach-O
**UUID** (measured on macOS 26: a different binary with the same UUID at an allowed
path connected; another UUID at that path was refused; the code hash is not
compared).

- **Every run of the compiled file a deploy makes goes through Walnut.app**, so the
  one Local Network choice for Walnut holds for every build, whoever runs the deploy.
  `scripts/dev-prod.sh` puts `Walnut --session-host --` in front of the file for its
  self-test, its smoke boot (and so the daemon that boot starts), its plugin check, the
  server's launchd job and a rollback, each after the file approves that exact command
  line (`walnut __session-host-approve`, `host_prefix_for`). Only the host's own
  refusal (exit 125), no Walnut.app, or `WALNUT_SESSION_HOST=0` runs the file directly.
  Before this, launchd ran the server from each deploy's new stage directory, and every
  deploy asked about `walnut-darwin-arm64` again (2026-11-04); then the smoke boot and a
  rollback still ran straight from the file, which a deploy from a Walnut session hid
  (macOS holds Walnut.app responsible for a session's processes) and a deploy from the
  land queue, a launchd agent that answers for itself, did not (2026-11-12).
  `tests/scripts/dev-prod-file-runs-under-host.test.ts` fails on a run that skips it.
- **No Walnut program on a Mac reaches the local network on its own.** The daemon's host
  facts never ask the cloud metadata address 169.254.169.254 on macOS (CDK's own rule:
  a Mac is not an EC2 instance it probes), which was the request that made a smoke boot's
  daemon ask. The same test lists every local-network address in `src/` with why it never
  makes a Mac program ask.
- **Every darwin file Walnut builds carries a fixed UUID and signing identifier**
  (`dev.openwalnut.walnut`, `dev.openwalnut.session-daemon`;
  `scripts/lib/macho-identity.mjs`). bun gives each file it compiles the UUID of
  bun's own runtime and the identifier `a.out`, shared with every bun program on the
  Mac and changed by every bun upgrade. With the fixed identity, a file that runs on
  its own from one place (a Mac host's daemon service, a server you run from your own
  launchd job) keeps its answer across updates. The deploy refuses a file without it
  before stopping the running server.
- A server started from Terminal never asks: macOS allows command-line tools run
  from Terminal or over SSH, and their children.
- If the answer was "Don't Allow", Walnut sees connections to the local network fail
  with "No route to host" and sends one letter naming the entry to turn on in
  **System Settings > Privacy & Security > Local Network**: Walnut, or the file's own
  name when the server runs on its own (`src/core/hosts/local-network-alert.ts`).

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
- An npm or terminal-only install with no `Walnut.app` keeps the plain identity
  of whatever started it. Nothing is installed and no bundle is built to change that.
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
- Walnut runs only a command recorded in
  `~/Library/Application Support/Open Walnut/session-host-launch.json`, and
  re-checks the payload's hash before starting it. The file holds the commands
  still in use (the deployed server and its daemon, at most 8); an approval whose
  payload file is gone is dropped at the next write. That file is owned by you and
  mode 0600, which stops other software from reusing the app as a launcher. Code
  running as your own user could rewrite it, so it is not a defence against
  same-user malware.

Implementation: `desktop/SessionHost.swift` (the supervisor, called by
`desktop/main.swift` before any UI exists), `src/providers/session-host.ts` (find
the app, approve the command), `src/providers/session-host-core.ts` (paths,
manifest, launch decision), `src/providers/desktop-app.ts` (find the app and read
which flags it knows without running it). Calendar: `desktop/CalendarBridge.swift`
plus `src/data/walnut-calendar.swift` (one protocol, compiled into the app and into
the helper), routed by `src/core/calendar/sources/eventkit.ts`.
