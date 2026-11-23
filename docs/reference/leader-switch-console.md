# The old leader's console

After a [leader switch](./leader-switch.md) the machine that handed the leader over (machine A,
today the Mac) keeps its console at the address its leader served: the Mac app, a browser and
the CLI on A keep using `http://localhost:<port>`. The console is served by A's host replica of
the new leader B (the replica A's daemon runs for B, as on every host), never by the
handed-over home, which stays as it was handed over. Behind the experiment `switchable_leader`
and a `leader_switch` section, like the switch itself: without them nothing here runs.

Code: `src/core/handed-over-console.ts` (the console files), `src/core/leader/switch/before-handover.ts`
and `console-credential.ts` (made at the handover), `src/replica/console-door.ts` (the door),
`src/core/leader/switch/handed-over.ts` (the standby shares the port with the console) and
`console-port.ts` (a switch back waits for the port).

## How it works

1. **At the handover** (`POST /api/leader/handover`, before the handover record is written), A's
   server mints a device `console-<machine>` into its `auth.json` (so the record rides the final
   batch to B) and writes the console file beside this account's machine id, outside every data
   home: `~/.local/state/open-walnut/console/<walnutId>.json`, mode 0600, holding the home it hands
   over, the address it listens on, the switch id, B's machine id and the device's plain token
   (the home holds only its hash). If this fails the handover is refused with its reason and A
   leads on. Later steps of the same kind (a host credential) go beside it in `before-handover.ts`.
   A console that will never stand is withdrawn (`withdrawConsole`): the handover refused after
   the mint, or cancelled, takes the device out of `auth.json` (its hash tombstoned) and removes
   the file. A home that boots holding the permit does the same for its own machine's console
   (`server.ts`): after a switch back A's `console-A` (which came back with B's data) and its
   file go, and so does one minted for a handover that rolled back. Nothing else removes it, so
   a switch back that is cancelled or refused leaves A's console standing.
2. **The console stands** only while the handed-over home's own marker
   (`local/leader-switch/handed-over.json`) says `handed-over` in that switch. A cancelled switch
   removes the marker and a switch back moves the home aside: either ends it.
3. **The door.** Every host replica looks once a second (an async read of one file) for a console
   file of its Walnut on its machine. While one stands, and once its own device copy knows the
   console's token (B sent it the device), it opens a second listener at that address, beside
   its own port, serving the same app and the same `/ws` handler. Until the port is free (the
   standby holds it) it tries again each second and says so in its holder file
   (`console/<walnutId>.holder.json`: pid, `waiting` or `serving`, address). A token its copy
   stops knowing (the device was removed on B) closes the door.
4. **The standby shares the port.** `walnut web` on the handed-over home never exits while its
   home stays handed over, so the process the Mac app started never ends under it:
   - A standby that sees a live holder of **its own port** closes its listener and stays, holding
     nothing, and prints `Walnut console listening on http://localhost:<port>: served by this
     machine's replica of <B> (pid N); ...`.
   - Started while the replica already serves (as this Walnut: `GET /api/v1/instance` names its
     id), it prints that line first and stays the same way, with the witnesses online or every
     one of them out of reach. It never leads and opens nothing in the home. A replica that only
     waits for the port gets 5 s to take it; then the standby listens and gives the port up as
     above.
   - Its page checks `/api/health` every 2 s and loads again once the port no longer answers as
     the standby, so the window moves to the console by itself (a failed check is only tried
     again). Any page a browser opens on the standby is that page.
   - While it holds no port it writes no pid file: it ends by its own marker check, never by
     `LocalSide.stopStandby`'s signal.
   - When the console ends (the holder goes, or does not answer as this Walnut for a minute: a
     pid used again, another program on the port), it takes the port back as the standby and
     says `Walnut standby listening on http://localhost:<port>: ...`.
   - It ends (exit 0) only when its home no longer stands handed over in its switch (a switch
     back moved it aside), or another standby of the home serves the port.
   - A port another program holds makes the start fail with `(EADDRINUSE)`, the word the Mac app
     looks for to try its next port.
5. **Switch back.** The promotion moves the handed-over home aside, so within a second the door
   closes and its holder file goes. The switch's start of A's leader (`side.ts`) waits for the
   port to be let go, at most 30 s, before it starts.

`resolveServerRole()` is unchanged (the console replica is role `replica`, placement `host`), and
`boot-policy.ts` has no new row or column.

## Who the console is to the new leader

**A device, never the person at the leader's machine.** On the door, and nowhere else, a request
that A's leader trusted without a credential gets `Authorization: Bearer <console token>`: the
same rule as the leader's own (`classifyLoopbackClient` in `src/web/middleware/local-trust.ts`:
a loopback socket, no proxy header, a loopback Host, no Origin or the console's own). A request
that brings its own Authorization keeps it. The replica's own port is a tunnel's and trusts
nothing. From there every request takes the path any browser of a replica takes: forwarded byte
for byte to B (which knows the device from the data the switch moved), or answered from the
copies while B is away.

So the console is never trusted more widely than A's leader trusted a local caller, and it is
trusted less: B sees a device on its tunnel port (`classifyLocalRequest` answers `tunnel-port`,
`fromThisMachine` is false). The device's rights were not widened for anything below.

One answer is never the leader's: `GET /api/config` through the door carries a `loginSession` with
no problem. The Mac app stops the listener on its port when that reports an ended login session
(`desktop/main.swift` replaceEndedSessionServer), and the listener there is the replica, which the
app did not start and cannot restart (this machine's daemon runs it); the leader's own login
session is another machine's.

The device shows in the leader's device list as `console-<machine>`. Removing it ends the
console's access until the next switch makes a new one.

## What works at the leader's own machine and not on this console

Enumerated from the routes (each answers a caller on the leader's machine only, or a person
there): on the console they are refused, or they act on the leader's machine.

| Refused (403) | Routes |
|---|---|
| Phones & Cloud: the public tunnel, signing a browser in, pairing or removing on the cloud companion, removing another device | `PUT /api/expose`, `POST /api/expose/retry`, `POST /api/devices/browser-code`, `POST`/`DELETE /api/devices` with `target: cloud`, device removal and re-pair of another device, `/api/auth/keys` |
| Settings sections only the person at the machine changes | `PUT /api/config` with a changed `expose`, backup target, `leader_switch` or `hosts.*.server`; `PUT /api/host-servers/:host` and its retries; `PUT /api/cloud/companion-build` and its retry |
| Backups: a new destination, restores, the recovery key, Google Drive | `/api/backup/destination/test` (new), `/snapshots` (elsewhere), `/restore*`, `/recovery-key*`, `/adopt`, `/gdrive/*` |
| Commands on hosts, secrets, daemon updates | `POST`/`DELETE /api/v1/host-exec/grants`, `PUT /api/v1/host-exec/hosts/:host`, `POST /api/v1/hosts/:host/daemon-update`, `PUT`/`DELETE /api/v1/secrets/:name` |
| The leader machine itself | Tailscale install and open, `POST /api/leader/handover` and `/cancel`, the Mac app's restart for an update, a heap snapshot |
| MCP servers | `POST /api/mcp/servers/:name/call` (a tool that may write) and `/restart` |
| Health, Places, the day timeline | `/api/health/*`, `/api/places/*`, `/api/time/timeline`, `/api/time/meetings/attendance` |
| Action cards of a local-only tool | `POST /api/v1/actions/invoke` for a tool marked local only |
| Passwords | the vault's `/join` and `/browser-key`; a typed password or key unlock over a link that is not private |
| The browser extension's channel | its poll, result, off and adopt routes |

| Acts on the leader's machine, not on this one | Routes |
|---|---|
| Reveal in Finder, open in an app or VS Code | `POST /api/files/reveal`, `/api/notes-v2/reveal` |
| System permissions, the clipboard, keep awake, audio | `/api/permissions/*`, `/api/keep-awake`, `/api/audio/*` |
| A session's local links | `vscode-uri`, `vscode-embed`, `service-preview`, `servers` (localhost links and paths of the leader's machine) |
| Terminal and the file viewer | `/ws` `terminal:*`, the file routes (the leader's file system) |
| Setting up the browser extension | `POST /api/v1/browser/extension/setup` (a folder on the leader) |

What changes for daily use, on the console of the machine that handed over: Settings shows the
leader's settings and saves them, except the sections in the first table (they answer "Only you,
at this computer, can ..."); Reveal in Finder and the session links open the leader's machine's
paths, which this machine does not have; Health and the day timeline are empty with an error;
the terminal opens on the leader's machine. Everything else (tasks, sessions and their chat,
notes, boards, the inbox, routines, search) works as on the leader.

## While the new leader is away

The console is a host replica's, so it does what a replica does away
([away reads and writes](../plan/walnut-replica-servers-impl.md)): the line at the top says
`Walnut's leader is away.` and since when (a console says this instead of "Your Mac is away",
since the Mac is the machine it runs on); reads come from this machine's copies; the writes a
replica keeps are kept here and replayed once when the leader is back; every other write is
refused with a line saying it needs the leader. Nothing is shown as saved that is not.

The list below is by feature, from a census of every route of a host replica (1100 HTTP routes:
468 reads, 632 writes; plus 26 WebSocket calls). Route rows are in `src/replica/route-table.ts`
(a route with no row is a read if it is a GET, a refusal otherwise), the console's words in
`web/src/api/leader-presence.ts`.

### Reads

A copy is the new leader's last sync, so rows can be a little old (the line at the top says how
old). A copy kind you left out of this host's copies in Settings answers "This is kept only on
your Mac, not in this copy." and never an empty list. 412 of the 468 reads run here.

| Feature | Answers from | Notes |
|---|---|---|
| Home task list, a task, Focus bar, folders, tags (`/api/tasks`, `/api/focus/tasks`) | the task copy, with this host's own pending writes laid over it | a task made here while away shows at once; a detail part it cannot find says "This task was made here while your Mac is away; this part of it shows once your Mac has it." |
| Sessions list, a session's record and settings (`/api/sessions`, `/api/sessions/:id`) | the sessions copy plus sessions started on this host | with the copy switched off only this host's sessions are listed, marked partial |
| A session's chat, changes, plan, files (`/api/sessions/:id/history`, `/api/v1/sessions/:id/transcript`) | this host's daemon, for a session that runs on this host | a session that runs elsewhere: "This session runs through your Mac; its conversation is there." |
| Notes: tree, content, links, tags (`/api/notes-v2/content/*`) | the notes copy | a note left out of the copy: "This note is kept only on your Mac." |
| Search (`/api/search`, `/api/notes-v2/search`) | the search copy: keyword always, by meaning only if this host keeps the index copy | tasks made here come first |
| Board (`/api/v1/tasks/:id/board`) | the boards copy with this host's journal laid over it | marked "Syncs when your Mac is back" when changed here |
| Inbox letters and bodies (`/api/v1/human-inbox`) | the inbox copy | a body over the copy's cap: "Letter bodies are kept only on your Mac." |
| Settings, Routines, Memory, Skills, Favorites, layout, Notifications (`/api/config`, `/api/routines`) | one copy each; Settings is an allowlisted part of the config | routines are listed, never run, here |
| Ask Walnut chat list (`/api/v1/conversations`) | the conversations copy | the list only: the messages of a chat are refused (below) |
| Server health and the signed-in cookie (`/api/health`) | this machine | |
| Projects, Topics, Org, Agents, Usage, Engines, Repositories, Commands, system pages (`/api/projects`, `/api/usage/*`, `/api/v1/org`) | this machine's own stores (no replica branch found) | may be empty or differ from the leader's |
| Time tracking, Apple Health, Places, Usage breakdowns, Quick Input, Approvals, Subagents, Passwords, Task threads | the route runs here, the handler refuses | with its own sentence (501 "... lives on the primary box only", vault: "Passwords are kept on your Mac and open only from it, its own network or Tailscale."), not the "Needs your Mac" line |

### Writes kept here and replayed once

38 routes (29 kept as journal records, 7 note writes, 2 quick questions). The journal is in this
host's daemon; the leader applies it in order when it is back, with a per-field merge against the
value this console showed. A retry with the same op id is applied once. A task write that names
any field outside the 23 queueable ones is refused whole, so nothing is half saved.

| Feature | What is kept | How the person sees it |
|---|---|---|
| Create a task, edit one (title, phase, priority, project, folder, dates, tags, note, description, summary, ...), complete, tick | one record each, `POST /api/tasks`, `PATCH /api/tasks/:id`, `.../complete` | the row shows at once with the mark "Syncs when your Mac is back" (hover: "Saved on this host. Your Mac takes it when it is back."; after the leader took it: "Your Mac took it; this view updates with its next copy.") |
| Pin, unpin, change tier, reorder the Focus bar (`/api/focus/*`) | task fields or one move | the same mark; reorder moves one task at a time |
| Save, create or delete a note (`PUT /api/notes-v2/content/*`) | a note record with the hash it was edited from | a stale hash answers 409 with the text this host shows; over 1 MB or a note outside the copy is refused |
| Edit a Board page, a project row, post in a Board thread (`/api/v1/tasks/:id/board/*`) | a board record, checked against the version shown | the mark on the Board |
| Send a message to a session (composer, `session:send`) | delivered at once to a session that runs on this host | text only; a session elsewhere or a picture is refused (below) |
| Answer a session's permission prompt | delivered to the session on this host | only a session that runs on this host |
| Quick question to Ask Walnut (`POST /api/sessions/quick-start`) | a session started here, its task journaled; adopted by the leader on return | needs a persona copy and a daemon that can start one |
| Sign this device out (`DELETE /api/devices/:name`) | this device's own pairing | another device or a cloud pairing is refused |

A session or plugin job on this host also keeps, through `walnut` calls only (not the console):
a letter to the user, `task_send`, routine create, pause and delete, MEMORY.md writes, and a
task start for a task that has a session here.

### Refused

594 write routes are refused: 142 with a line of their own, 452 with the generic one. 56 reads
and 17 WebSocket calls are refused too. The console shows `Needs your Mac. ` and then the reason;
the server's own sentence is shown only for a reason the console does not know.

| Feature | Line the console shows |
|---|---|
| Any write with no row of its own (452: Passwords 38, voice 30, settings 30, Org 23, task actions 18, Browser 16, Routines run, Files, Projects, Inbox answers, session controls, Hosts, Plugins, Skills, Topics, ...) | Needs your Mac. Your Mac is away right now. (also, when a companion is silent too: Neither your Mac nor the cloud companion answers right now.) |
| Change settings (`PUT /api/config`) | Needs your Mac. Changing settings needs your Mac. |
| Change a routine | Needs your Mac. Changing a routine needs your Mac. |
| Change favorites or layout | Needs your Mac. Changing favorites or the layout needs your Mac. |
| Change a task other than a plain edit (delete, merge, folders, batch) | Needs your Mac. Changing a task needs your Mac for now. |
| Reorder a project or task list | Needs your Mac. Reordering a list needs your Mac; the Focus bar can be reordered while it is away. |
| Act on a session (stop, restart, fork, model, upload), start a session in a folder, `session:start` | Needs your Mac. Sending to a session needs your Mac for now. |
| Send to a session that runs elsewhere, or with pictures | Needs your Mac. This session runs through your Mac; its conversation is there. / Pictures reach a session through your Mac; send the text alone, or wait for your Mac. |
| Ask Walnut: read a chat's messages, send, stop | Needs your Mac. The messages of a chat are on your Mac; this host keeps only the list. / Asking Walnut needs your Mac for now. |
| Notes: move, rename, a folder or an attachment (made or deleted), picture, tag rename | Needs your Mac. Editing a note works while your Mac is away; moving, renaming, folders and pictures need your Mac. |
| Open files and folders | Needs your Mac. Opening files needs your Mac for now. |
| Hosts overview, another host, run a command or copy between hosts | Needs your Mac. The hosts overview is read through your Mac. / Commands on another host run through your Mac, which keeps your grants. |
| Plugins (reads too), Drawings, Secrets, Terminal | Needs your Mac. Plugins run on your Mac. / Drawings are kept in the Notes of your main Walnut server, so they are opened and changed there. / Your secrets are kept on your Mac. / The terminal runs through your Mac. |
| Devices, push, activity detail, any WebSocket call not listed | Needs your Mac. Only your Mac can do this. |
| A write that raced the leader's return, or timed out | Your Mac just came back; try again in a few seconds. / Your Mac did not answer in time, and it may have kept the change; check it before you try again. |
| This host cannot keep the write (journal full, disk full, daemon down or old) | This host already keeps as many changes as it can until your Mac is back; this one was not kept. / This host's Walnut daemon did not answer. |

### Known gaps

- These reads answer empty or with a bare error and no "Needs your Mac": `/api/first-run` answers `{pending: []}` (`src/web/routes/first-run.ts:22-27`), `/api/v1/trigger-templates` answers `{templates: []}` (`src/web/routes/trigger-templates-v1.ts:39-41`), `/api/hosts/ssh-resolve` answers 204 (`src/web/routes/hosts.ts:78`), `/api/host-servers` answers 404 (`src/web/routes/host-servers.ts:116-117`).
- Reads of data only the leader has (Projects, Topics, Org, Agents, Usage, the usage and time pages) run on this machine's own stores with no replica check, so they may be empty or differ from the leader's.
- Words that say "Mac" on this console: see "Not built yet" below.

## The Mac app

`desktop/main.swift` is unchanged. What it does at each moment (checked continuously by
`scripts/leader-switch/mac-app-replay.ts`, a step for step port of its server handling, its output
and exit order included: Swift stops its output reader at an exit without reading what is left):

| Moment | What the app sees | What it does |
|---|---|---|
| only the standby runs (no replica yet) | `GET /` 200 (the standby page, which checks the port every 2 s), the listening line | attaches to the server it started |
| the standby gives its port up | its process stays (no exit); the port is the replica's a moment later | nothing: no restart, no spawn; the standby page sees the console answer and loads it |
| the replica has just taken over | `GET /` 200, `/api/config` with a login session it leaves alone | stays attached; a `walnut web` started now prints the console line and stays without the port |
| the new leader is cut off | the replica's own page and copies, `GET /` 200 | stays attached; its watchdog only logs |
| the replica stops (its daemon does not start it again) | its own process takes the port back as the standby | stays attached; the standby page loads |

A start that printed its line and exited at once (the first version of this) could lose that line
to Swift's reader and end on the app's error screen; the replay's unit test keeps that case as its
control. Nothing in the console flow exits now until the home leads again.

The app runs `walnut update --auto` once it sees its server's line; on a handed-over home that
update does nothing (`src/commands/update.ts`), so the home is not written. A person's own
`walnut update` there still installs, and writes its install record in the home as it does
anywhere.

Limits that stay the app's or the console's:

- **A fresh launch beside a running console** (the usual case after a login: the daemon starts
  the replica, the app comes later) attaches without a child, so no standby stands by. If the
  replica then stops and its daemon does not start it again, the window stays on a dead page
  until the app's Retry, which starts the standby. Covering it needs the daemon to start the
  standby, which this phase does not change.
- **The console's page when the standby takes the port back**: an open console page is not told;
  its requests get 409 `handed_over` until it is loaded again, and then it is the standby page.
- After a crash of the app its `server.pid` still names the old standby;
should the replica later get that pid, the app's orphan check (`isOwnServerCommand`, which accepts
`web --replica`) would stop it, and the daemon starts it again. Unlikely, and only an app change
fixes it.

## Data

The console files are machine data outside every data home (home manifest
`state.console`); the replica's install root `~/.open-walnut-host` is `home.host-replica`. The
handed-over home is not written: every path of its leader data and machine data stays byte for
byte (the rehearsal hashes it by the manifest's classes; a daemon whose state dir is inside the
home, as installed, changes only rebuildable paths there).

## Rehearsal

`bun scripts/leader-switch-rehearsal.ts <dir> --console [--as-installed] [--browser] [--scale] [--away-seconds N]`
(the built app: `bun run build` first). A leads, switches to B, becomes B's host; the Mac app's
handling runs the whole time; B takes A as a host; the console serves at A's address; writes
land on B once; `walnut web` by hand (witnesses online and out of reach) only names the console;
B is cut off (SIGSTOP) and comes back; A's home is checked by its manifest classes; the switch
back gives the port back. `--browser` walks the console in Chromium (Home, a task, its session's
chat and a message, its Board, a rename, a note and an edit, Settings, then the same page while
B is away) and records it; `--scale` writes a home of 5,000 tasks, 1,000 sessions and 1,000
notes first and times `/` and a session page five times each at the console and at the leader.
Its test is `tests/e2e/leader-switch-console-e2e.test.ts`.

## Not built yet

- **B takes A as a host by hand**: in this phase the console needs B to have A as a host with
  its server on (Settings, Hosts). The switch doing it, with the host credential, is the
  cross-machine phase's (the leader-dialed host link). What changes then: how B reaches A's
  daemon; the replica side (its forward to the leader, the door) stays.
- **One daemon for both**: on a real Mac its one daemon was the old leader's and becomes B's
  host. The rehearsal gives A's host a daemon of its own (a server refuses an installed daemon
  dir under a test's HOME); a daemon taking a new leader of the same Walnut is the cross-machine
  phase's.
- **Words that say Mac**: a write kept away says "Syncs when your Mac is back" and a refusal
  "Needs your Mac" on the console too.
- **After a switch back** A's daemon still holds B's server spec (its replica runs, with B a
  standby); removing it is the cross-machine phase's.
- **The Mac app at a switch back**: the standby ends when the promotion moves its home aside, and
  the app starts `walnut web` again a second later while the switch starts its own leader on
  that home. That start refuses until the promotion is done (a `promoted.json` not yet `led`,
  [the switch](./leader-switch.md)) and the app tries again on its restart clock. The switch's
  leader becoming the app's server is the cross-machine phase's.
