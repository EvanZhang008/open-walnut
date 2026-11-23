# The manual leader switch

Moves the leader of a Walnut (the machine that writes its data, runs its timers and triggers
and sends anything outward) to another machine by hand, with nothing lost, nothing sent twice,
and a way back. Code: `src/core/leader/switch/`, CLI `walnut leader`. Behind the experiment
`switchable_leader` **and** a `leader_switch` section in config.yaml; with either missing nothing
of it runs, no boot path changes and the outward doors are not checked.

It joins two earlier pieces: the [standby copy](./standby-copy.md) (the whole data folder,
copied in batches of one moment) and the [write permission](./leader-write-permission.md)
(numbered records kept by a fixed majority of witnesses).

**This phase runs both machines on one computer**: the witnesses are three local directories
and each "machine" is a home, a standby folder and a machine-id file. Nothing crosses a network
and no credential is involved. Later phases replace the local pieces (witness transport,
`LocalSide`, the standby transport) with remote ones; the flow and its rules stay.

## Setting it up

```yaml
experimental:
  switchable_leader: true
standby:
  dir: /srv/b/standby          # the batches of the current leader land here (the other machine's standby_dir)
leader_switch:
  witnesses:
    - { id: w1, dir: /srv/witness/w1 }
    - { id: w2, dir: /srv/witness/w2 }
    - { id: w3, dir: /srv/witness/w3 }
  machines:
    - { id: machine-a, home: /srv/a/home, standby_dir: /srv/a/standby, port: 3456 }
    - { id: machine-b, home: /srv/b/home, standby_dir: /srv/b/standby, port: 3460 }
  back_window_hours: 168
```

`walnut leader witnesses init` sets up each witness directory once. A machine's id is its one
stable id (`src/core/machine-id.ts`, `~/.local/state/open-walnut/machine-id`, the id the daemons
send too); it is the holder id of the permission, and the `id` of its `machines` entry.
`WALNUT_MACHINE_ID_FILE` names another file, read as it is and never made (the one-machine
rehearsal's two "machines" only).
Beside it, `leader-instance/` holds the permit core's instance lock: one leader server per
machine id asks for the permission (a second one is refused at boot).

Only the person at the machine changes the `leader_switch` section through the API
(`PUT /api/config` answers 403 to anyone else): its machines name the command that starts a
server, and its witnesses decide who may write.

## Role at boot

**Who writes a record.** The witnesses take a renew, a handover or a cancel only from the
process (incarnation) that wrote the record they hold (`docs/reference/leader-write-permission.md`).
So every record of a switch is written by a server, never by the switch command: the old
leader's server writes the handover and the cancel (`POST /api/leader/handover`, `/cancel`,
answered only to a request from this machine), the new leader's server writes the commit
when the switch starts it told the handover's number (`WALNUT_LEADER_SWITCH_COMMIT`). The
switch command only reads the witnesses.

A server that would boot as the leader (`src/web/server.ts`, right after the single-instance
lock; `boot.ts`, `runtime.ts`):

| What it finds | What it does |
|---|---|
| `local/leader-switch/handed-over.json` in its home | **runs as a standby** ([Standby](#standby)), with or without witnesses, **and with the experiment or the section gone**: it opens nothing in the home and answers "this machine handed the leader to X (switch S)" (or "is handing the leader to X: --resume or --cancel") |
| `local/leader-switch/promoted.json` not yet `led` (a standby copy the switch is still making into this home) | refuses, unless it is the switch's own trial or commit start |
| another leader server of this machine holds the instance lock | refuses |
| a majority of witnesses names another machine (its record, a handover between two others, or another machine's release) | **runs as a standby** naming that machine |
| a handover to this machine it was not told to commit | refuses ("`walnut leader switch --resume` finishes it") |
| its own record of this process, or none at all (the very first leader) | leads; renews every 15 s |
| a record an earlier process of this machine wrote (a restart, or the old leader's handover after a switch rolled back once its server had stopped) | **boots with every outward door closed** until that record runs out at the witnesses (up to a minute), then grants itself and leads |
| no majority answers | **boots with every outward door closed** and keeps asking every 5 s |

Why not lead in the first rows and lead in the last: a handed-over home is known not to be the
data home any more (booting it as the server would take writes into a dead copy). It does not
exit either: a launcher would restart it in a loop. It stays up as a standby that leads nothing.
A home without the marker was never handed over (the marker is written before any handover
record), so its data is the newest there is; refusing would take Walnut down whenever two
witnesses are unreachable. While its doors are closed it sends nothing, fires no routine and
claims no trigger. An ephemeral server never asks the witnesses (its config is the user's),
unless `WALNUT_EPHEMERAL_LEADER_SWITCH=1`.

`resolveServerRole()` is unchanged, and so are the leader and replica columns of
`boot-policy.ts`: the permission is checked beside them, not inside. The switch's trial start is
the table's third column ([The trial column](#the-trial-column)).

`GET /api/leader/status` (mounted only while the permit runs): version, machine, trial or not,
and the permission (state, may act, time left, record). A standby answers it too, with
`standby: true` and who leads ([Standby](#standby)).

## The switch

`walnut leader switch --to <machine>` (run with the leader's home). A stop, not a live freeze:
there is no read-only mode on the leader, and building one over every route, timer and
SQLite write was judged too risky. Each step is written to `local/leader-switch/switch-state.json`
in the old home before it runs and is safe to repeat; `--resume` continues after a kill,
`--cancel` rolls back a switch that has not committed.

1. **preflight**: the old leader runs with the permission (only its process can hand it over), the standby copy has
   a complete batch under 5 minutes old and verifies without drift, the copy's config has the
   experiment and the section, a majority of witnesses answers and names the old leader, the
   new home's disk has room, the new leader's program is not older than the old one's, no
   server runs on the new home. Any failure refuses with the reasons; nothing changed.
2. **handover**: the marker `handed-over.json` (state `switching`) goes into the old home
   first, then the old leader's server writes its `handover` record to a majority of the
   witnesses and acts no more (asked through `POST /api/leader/handover`). Before that record
   it makes what must ride the final batch (`before-handover.ts`: today this machine's console
   device, [The old leader's console](./leader-switch-console.md)); one that fails refuses the
   handover. While it runs it may still cancel it.
3. **stop-source**: a planned stop (SIGTERM, SIGKILL after 30 s). Sessions and detached work
   keep running under the existing restart rules. The downtime starts here.
4. **final-batch**: one standby batch of the stopped home (a batch voided by an outside writer
   is tried again, six times), a verify pass, and a second batch that must find nothing changed.
5. **promote**: the copy becomes the new home in one rename (`promote.ts`; a folder already at
   that path is kept as `<home>.before-<switch>`; `promoted.json` goes into the copy before
   the rename, so the home is marked from the instant it exists), its read-only modes become read-write, and
   what names the old home's path is rewritten: the applied-ops ledger's `home` column
   (without it every op id the old leader applied would apply again on the new one: the
   rehearsal shows it) and `standby.dir` (the new leader's batches go to the old machine's
   standby folder, for the switch back). Sends the old leader had begun and not settled
   (mail rows `sending` or `unknown`) are listed as "outcome unknown".
6. **trial**: an offline self-check (every file of the batch at its size, every database
   through integrity_check with the old home's row count, config.yaml naming no path in the
   old home), then the new leader starts with `WALNUT_LEADER_TRIAL=1`: it never asks for the
   permission, so every outward door stays closed, and every gate reads the boot policy's
   trial column ([below](#the-trial-column)): HTTP, the databases and their migrations, and
   nothing else (no plugin, standby copy, session, timer, routine, git job or outward work);
   its version must read the data, the
   old home's newest task and a note must read back through its API (the same read-back as the
   restore drill's boot check, `src/core/trial-start/read-back.ts`: the note is the first one under
   the vault root, `artifacts/` once the notes moved into the one tree, `notes/` before). Then it stops. A
   resumed trial skips the size and row comparison (its server may have touched the home).
7. **commit**: the new leader starts for real, told the handover's number: its own `renew` on
   top of the handover reaches a majority (a `grant` once the handover ran out at the
   witnesses, for a long trial). From here the old machine's `mayAct()` is false for good and
   the new one's is true; the marker becomes `handed-over` with the record number,
   `promoted.json` becomes `led`, and the new home's `local/leader-switch/history.json` names
   the switch (for `--back`).
8. **start-target**: the new leader opens its doors. The downtime ends when it says it may act.

Any failure before the commit (a trial that fails included) rolls back. The new leader's
server is stopped first, so what the witnesses hold next is final; when they show its commit
the switch goes forward instead. When the old leader's server still runs, it cancels its
handover and leads at once (a handover and a cancel never both stand). Once it stopped no
process can cancel (the record was its process's): the tried home goes aside as
`<home>.trial-failed-<switch>` (the folder it displaced comes back), the standby copy is built
again from its chunks, the marker is removed and the old leader starts again, **with its
doors closed until its handover runs out at the witnesses (up to a minute)**, then grants
itself. Nothing was lost: the old home was never changed.

**About the brief's step names.** The brief named step 2 "handover-started" and step 5
"commit: the handover record reaches a majority". In the permit core a handover record that
reached a majority can still be cancelled by its writer; what ends the old machine's lead for
good is the new holder's record on top of it. So the "handover-started" record is the
`handover` record, and the commit is the new holder's `renew` (or `grant`) on top of it.

One switch command runs per home at a time (`local/leader-switch/switch.lock`): a second
`--resume` or `--cancel` from another terminal is refused while the first runs.

### The trial column

`BOOT_POLICY` (`src/core/boot-policy.ts`) has a third column beside `leader` and `replica`:
`trial`, what a trial start runs: the switch's, and the restore drill's boot check
(docs/reference/backups.md, "Restore drill"), one mode for both (`bootMode() === 'trial'`, with
`trialPurpose()` naming which). The permission's boot step decides the switch's trial
(`WALNUT_LEADER_TRIAL=1`, read once in `src/web/server.ts` and passed to `boot.ts`); the drill's
is entered only through its ticket (`src/core/trial-start/ticket.ts`), holds no permit, and has
its outward doors closed for the life of the process (`closeOutwardDoorsForTrial`). server.ts
then sets the boot mode (`setBootMode('trial', 'leader-switch' | 'restore-drill')`) before the first gate reads the table,
and from there `bootPolicy(job)` is on only where the row's `trial` is (a trial is a leader
start, so a row on in a trial is on in the leader column too). The trial needs HTTP, the
databases and their migrations to read the home back; everything else is off, routes that act
outward included (it listens on a real port: `backup-routes` is off, a POST there uploads with no door). This replaced
the trial's scattered checks (a second `WALNUT_LEADER_TRIAL` read before the plugin load, one
in the standby runner, and `isEphemeral = true` for the rest of the boot). Eight gates that
had no row got one (`org-duties`, `org-autostart`, `start-queue`, `browser-sign-in-sweep`:
`role() === 'leader'` before; `standby-copy`, `focus-spaces`: `!isFollower()` before;
`disk-watermark`: `!isEphemeral` alone before, and `topics-runtime`: no gate at all, so both
are on in the replica column too), each with the leader and replica values its gate had;
`tests/core/boot-policy.test.ts` pins both columns, row by row, to their values before the
trial column, and this table to the code.

| Job | Trial | Why |
|---|---|---|
| `foreign-db-guard` | on | the guard that no other process holds the databases the trial opens |
| `cloud-exec` | off | off in the leader column already (a companion or replica job) |
| `local-daemon` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none (no session daemon) |
| `cloud-box-probe` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `local-claude-probe` | off | probes the Claude CLI on this machine: the trial starts no session |
| `trust-proxy` | off | off in the leader column already (a companion or replica job) |
| `companion-ingest-routes` | off | off in the leader column already (a companion or replica job) |
| `backup-routes` | off | a POST uploads a backup with no outward door: the trial listens on a real port |
| `plugin-apps` | on | a static route only; no plugin loads |
| `host-network-door` | off | off in the leader column already (a companion or replica job) |
| `host-network` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `plugin-jobs` | off | plugin code may send outward: no plugin loads in a trial |
| `v1-forward` | off | off in the leader column already (a companion or replica job) |
| `backup-leader` | off | off in the leader column already (a companion or replica job) |
| `leader-heartbeat` | off | tells the companion the Mac leads: the trial does not lead |
| `replica-pushes` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `self-api-credential` | off | off in the leader column already (a companion or replica job) |
| `setup-token-banner` | off | off in the leader column already (a companion or replica job) |
| `terminal-sweep` | off | reaches hosts over ssh: reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `letter-push` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `work-card` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `approvals` | off | its clock expires and pushes approvals: nobody asks the trial for one |
| `audio` | off | capture and transcription: nothing to record in a trial |
| `git-pull` | off | writes the data repo: no git pull, commit, compaction or maintenance before the commit |
| `git-auto-commit` | off | writes the data repo: no git pull, commit, compaction or maintenance before the commit |
| `git-maintenance` | off | writes the data repo: no git pull, commit, compaction or maintenance before the commit |
| `git-compaction` | off | writes the data repo: no git pull, commit, compaction or maintenance before the commit |
| `session-auto-recover` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none |
| `session-reconcile` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none (it would mark the old leader's sessions dead) |
| `completed-task-session-migration` | on | a data migration, as the databases' own; idempotent, the commit start finds it done |
| `one-session-per-task` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none (it detaches sessions and makes daemon triggers) |
| `stream-file-cleanup` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none |
| `session-integrity-check` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none |
| `notes-watcher` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `notes-semantic` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `search-wiring` | off | search indexing: the trial reads one note by its path |
| `thread-ai` | off | model calls on session results: none in a trial |
| `revoke-queue` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `send-path-canary` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `primary-store-jobs` | off | projections, backups, keep-awake, usage waits: a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `companion-queues` | off | off in the leader column already (a companion or replica job) |
| `companion-stream-door` | off | a listener for other machines: the trial takes no connection from them |
| `companion-stream-forward` | off | off in the leader column already (a companion or replica job) |
| `hub-port-door` | off | a listener for other machines: the trial takes no connection from them |
| `hook-task-domains` | off | hook actions on task and routine events: a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `session-request-sweep` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none |
| `lane-orphan-passes` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none |
| `lane-ask-sync` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none |
| `pin-retirement` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `usage-collect` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `budget-letters` | off | letters to the user: reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `session-health-monitor` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none |
| `overview-maintainer` | off | model calls that write project skills: a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `project-summary` | off | model calls: a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `host-learning` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `routine-wake` | off | routines and triggers: no routine fires in a trial |
| `workspace-watch` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `host-wiring` | off | ssh, host daemons and their alerts: reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `expose-runtime` | off | the public tunnel: reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `update-check` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `plugins` | off | plugin code may send outward: no plugin loads in a trial |
| `companion-plugin-cards` | off | off in the leader column already (a companion or replica job) |
| `plugin-sync-polling` | off | plugin code may send outward: no plugin loads in a trial |
| `cron` | off | routines and triggers: no routine fires in a trial |
| `triage-bootstrap` | off | writes routines into cron-jobs.json: the commit start does |
| `board-store-watch` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `board-kanban-watch` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `board-reminders` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `wait-until` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it (with promised follow-ups, rechecks, asks, status checks) |
| `health-monitor` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `user-status` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `host-exec-grants` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `fleet-secrets` | off | sends secrets to hosts: reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `private-task-gate` | off | resumes the checks of pushes to outside services: no push leaves a trial |
| `title-reconciler` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `link-tags` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `pr-watch` | off | reads GitHub: reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `change-watch` | off | reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `notes-indexer` | off | a timer or watcher that acts on the data: the trial only reads back; the commit start runs it |
| `stt-auto-setup` | off | downloads a voice model: reaches outside the home: the trial sends, pushes, dials and probes nothing |
| `org-duties` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none (the org nodes' duties) |
| `org-autostart` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none (Main and the VPs) |
| `start-queue` | off | sessions are the old leader's until the commit: the trial starts, wakes, recovers and reconciles none (queued starts) |
| `standby-copy` | off | this home has not led yet: it is copied nowhere until the commit |
| `disk-watermark` | off | a timer that notifies and stops writes at 90%: the commit start watches the disk |
| `browser-sign-in-sweep` | off | signs out browsers a year old, writing the devices: the commit start does |
| `focus-spaces` | off | writes the focus file and its quiet hold: the commit start does |
| `topics-runtime` | off | posts members' replies and mails people: the trial sends nothing |

What is not a row stays as it was: starts that only follow `role() === 'leader'` sit inside
rows a trial turns off (the session and org clocks under `user-status`, the router wakes under
`cron`), except the boot's data migrations (router areas, VP titles, artifacts) and the browser
sign-in routes (routes only: their yearly sweep is a row), which a trial runs.

## Standby

A home that handed the leader over (the marker), or whose boot finds the witnesses naming
another machine, does not exit: it runs as a standby on the server's port, so a launcher keeps
it and no restart loop starts.

**It opens nothing in the home.** The handed-over home is what a switch falls back to and stays
byte for byte as it was: opening its databases would write their WAL and shm files and run
migrations, and the server's lock file would land in it. So the standby is not the server with
its jobs turned off (a boot policy column of all `off`, read by gates the standby never
reaches, would mean nothing); server.ts checks the marker before the instance lock, the
databases and the first log line, and starts `src/core/leader/switch/handed-over.ts` instead:

- `GET /api/leader/status`: `standby: true`, `leader` (the machine the witnesses name now, read
  live and read-only, else the one the marker names), `switchId`, the marker, the record,
  `message` ("this machine handed the leader to machine-b (switch S)"), and
  `permit: { state: 'standby', mayAct: false }`;
- `GET /` (and `/index.html`): **200**, a short page that says the same and names the leader;
  `GET /api/health` and `GET /api/config`: **200** `{ standby: true, leader, switchId, message }`.
  These are what the Mac app checks before it attaches (`desktop/main.swift` checkExistingServer
  and pollForServer want a 200 on `/`, then `/api/config` for the login session): with a 409 it
  would try the next port and start a second server, or count the start as failed and restart.
  A health probe therefore counts a standby as up: whether it leads is `standby` in
  `GET /api/leader/status`;
- every other request: **409** `{ code: 'handed_over', error: <message>, leader, switchId }`,
  reads included (it has no data open to read).

It listens on loopback (127.0.0.1) unless the server's own bind setting names an address
(`bind-address.ts`: `--bind`, `WALNUT_BIND_ADDRESS`). Status requests at the same moment share
one read of the witnesses. A second standby of the same home, while one runs (its pid file names
it and its port confirms), starts nothing and exits with the error "a standby of this home
already runs".

It writes one file, outside the home: its pid and port beside the instance lock
(`leader-instance/standby-<hash of the home>.json`, `machine-id.ts standbyServerFile`), removed
when it stops or exits. A SIGKILL leaves it, so the switch's side signals the pid it names only
once that pid's port answers that it is this standby (`confirmStandby`). Logs go to the run dir,
as every server's. `walnut web` on a marked home skips what it does before the server (the
switch to restored data, the update on restart), both of which write in the home. It reaches no outward door and fires nothing, so the door
log in the home gets no line; the rehearsal hashes the whole home (every path and its bytes)
before and after a standby run, with the witnesses online and with all of them unreachable.

Found through the witnesses instead (no marker: a home that never handed over, say machine B's
own home started while A leads), the boot reached the instance lock and the permission's first
line already; the lock is let go and the standby starts. That home was not the fallback copy.

**Back to leading.** `walnut leader switch --back`, run from the new leader, ends with the old
machine leading again: the switch's side (`side.ts`) counts a standby as no running server
(preflight does not refuse it), stops it before the promotion moves its home aside (the
handed-over home is kept as `<home>.before-<switch>`), and every `startServer` on a home stops
its standby first, since it holds the port. The fresh copy then starts as the trial and the
leader on that path. A start the switch makes that comes up as a standby (another machine
leads) fails at once with the standby's message instead of waiting for a server that never
comes. Under a launcher that restarts what it sees stop, a stopped standby can be started
again between that stop and the switch's start (the port is then taken, or a standby runs on
the promoted path); stopping it through the launcher is the next phase's.

**The old leader's console.** Once the new leader runs a replica on the old machine (that
machine as one of its hosts), the replica serves the old machine's console at the address its
leader served, and the standby shares that port with it (it gives the port up and stays, and takes
it back if the console ends): the Mac app, a browser and `walnut web` on that machine keep
working, as a device of the new leader. The handover makes what it needs
(a console device and a file outside the home). See [The old leader's console](./leader-switch-console.md).

### `--back`

`walnut leader switch --back` from the new leader's home, within `back_window_hours`
(default 168) of the switch: a normal switch to the machine named in `history.json`. The
changes made since come back by the standby batches the other way (the new leader's
`standby.dir` was pointed at the old machine's standby folder at the promotion), so the
switch back needs that copy to be recent too. The handed-over old home is moved aside
(`<home>.before-<switch>`, kept, still marked) and the fresh copy takes its path.

**What a switch back cannot undo**: anything already sent outward (mail, pushes, a plugin's
posts), and the time the new leader's routines already ran.

### The old leader's last batch on the new machine

The promotion moves the copy out of the new machine's standby folder (its `standby_dir`), but
the chunks and the manifest of the final batch stay there: as large as the home, and nothing
sends to that folder any more. Through the switch-back window they are kept: the old leader's
last state, for a person to look at should the new home turn out wrong, and a switch back
finds the old leader sending into a folder that holds most chunks already. Past it, the new
leader's standby runner removes them after a complete batch of its own
(`src/core/leader/switch/standby-cleanup.ts`, from `afterSwitchCleanup` in
`src/core/standby/runner.ts`; started detached, one at a time, so the batch loop never waits on
a removal of 20 GB), when all of these hold:

- the home leads because of that switch (its last `history.json` entry, `promoted.json` `led` by
  the same switch), no switch from it is under way, and it carries no handed-over marker;
- `back_window_hours` passed since the commit;
- the home's own standby took a complete batch after the commit, so the data has a second copy
  before this one goes;
- the folder's last batch was committed before the switch committed: a later one means a
  standby sends there again (the old machine leads again), and it is left alone;
- the folder neither holds nor sits in the home or the home's own standby target, links
  resolved (the own target only when it is a folder here: with `standby.host` it is on that
  host, and the folder's own state and lock, which every sender to it commits through, keep
  it safe).

`StandbyTarget.discard` empties it under the target's lock: `standby.json` first, then the
manifests, chunks, copy and stats are renamed into `.discard-<time>/` and that is removed. A
failure or a kill partway leaves the old folder or a `.discard-*` folder: the next look
(`finishDiscard`, which acts only when such a folder is there) moves what is left of the batch
into it and removes it. The folder stays, empty: a valid target for a later sender, which sends
a whole batch. `drift/` stays. A top-level entry (`chunks/`, `copy/`, ...) that is a link, or
resolves outside the folder, is left as it is; a link deeper inside (in `copy/`, say) is removed
as a link and never followed, so nothing outside the folder is touched.

### What a person sees

| Failure | What happens | What the person sees |
|---|---|---|
| preflight fails | nothing changes | `leader: <reasons>`, exit 1 |
| the old leader is not running | refused at preflight: only its process can hand over | `leader: <reasons>`, exit 1 |
| the handover does not reach a majority | the old leader's server cancels what part stood and leads on | `Rolled back: ...`, exit 3, old leader running |
| a void final batch six times, a home that still changes, a copy that fails its self-check, a trial start that fails, a version too old | rolled back, old leader started again; it acts once its handover ran out (up to a minute) | `Rolled back: <the step and why>`, exit 3 |
| the command killed anywhere | the next `--resume` finishes or rolls back | the step it resumes at, then the outcome |
| the cancel cannot reach a majority, or no majority answers whether the new leader committed | both sides stay stopped | "rerun with --cancel (no witness majority, no leader)", exit 1 |
| a second switch command on the same home | refused | "another `walnut leader switch` runs on this home" |
| the new leader does not start after the commit | it cannot roll back; the old home stays handed over | "committed, but the new leader did not start ... rerun with --resume", exit 1 |
| someone starts the old home by hand | it runs as a standby, experiment on or off, witnesses reachable or not: leads nothing, opens nothing in the home | `/api/leader/status` says who leads; every other request 409 `handed_over` |
| someone starts the half-promoted new home by hand | it refuses to boot | "the standby copy that switch X is making into the new leader's home" |

## Restarts

The witnesses take a renew only from the process that wrote the record, so a new process of
the leader holds only once its predecessor's record is gone. **A planned stop** (a deploy, a
restart, `stopServer`) closes the doors at once, lets the sends already on their way end (up
to a second), then writes a `release` record (permit core) and waits at most 3 s for a
majority: the next process of the same machine sees its own release and grants itself at once,
without the back-off. **A crash**, or a release no majority took, leaves the record: the next
process boots with its doors closed until it runs out at the witnesses (`validMs +
witnessMarginMs`, 62 s) and grants itself then. Another machine never takes a release over
(that is a switch, by hand); the rehearsal's `--restarts` measures both cases. Nothing due in
between is lost or repeated: routine slots stay due and run once, trigger fires are replayed,
an approved mail is sent once by the reconcile.

## Outward doors

The few functions every outward send and every timer or trigger fire passes call
`if (leaderPermitActive()) assertOutwardDoor(kind, opId)` (`doors.ts`); `OUTWARD_DOORS` in
`doors.ts` lists each with its file, function and what a refusal does, and
`tests/core/leader/switch/outward-doors-ratchet.test.ts` fails when a new call site of an
outward primitive appears without the check, or when the check comes after the call it
guards. Kinds: mail send, unsubscribe, mail writes (read flags, moves, invite answers),
pushes, routine fires, trigger fires and arming, plugin jobs and plugin writes, calendar
writes, session wakes (wait-until, promised follow-ups, lead wakes), task sync, git pushes
(the data repo's compaction is asked before its worker forks) and companion uploads.

Only a Walnut with the experiment on **and** witnesses set up registers a checker; otherwise
`leaderPermitActive()` is false, every door returns at once and no permit code is loaded
(`doors.ts` imports nothing; the rehearsal's "no witnesses" scenario records every module of
`src/core/leader/` a real server loads with `switchable_leader: true` and `every_experiment: true` and finds only `doors.ts`).

**A refusal never loses the work and never repeats it**: a routine slot stays due and its
catch-up runs it once; a trigger fire is not claimed or acked, so the daemon replays it; an
approved mail stays `approved` and the reconcile sends it once the doors open; pushes are held
on disk and one push says what waited; a lead wake waits for the doors to open in memory. A
remote delete, a list rename, the old copy of a cross-source move ("[Moved]", completed) and an
answered unsubscribe letter are held on disk instead, in `cache/leader-deferred-work.json`
(`src/core/deferred-door-work.ts`, leader data: it moves with the home, so what the old leader
held during a handover is done by the new one). One entry per key (a second rename of the same
list replaces the first); the permit runtime arms it at boot, and at each opening of the doors
every entry is claimed: stamped in the file with this process (host, pid, a token of this
incarnation), run, and only then removed. Delivery is **at least once**: a stop or a crash
between the claim and the removal leaves the stamped entry, and the next replay takes back a
stamp of a process that is gone (another host's, a dead pid's, an earlier incarnation's, or one
over an hour old) and runs it again. A second run is harmless: the rename or the moved mark is
set again, a delete is answered 404, and the unsubscribe ledger's claim refuses a second
attempt. A refusal during the replay holds it again; an entry whose plugin is not loaded gives
its claim back and is tried again every 5 minutes and at each opening. A remote delete that
fails (an error, not a refusal) is held again for a later try, 5 tries in all; a source with
`confirmRemoteDeleted` is also retried by the sync tick from its tombstone. The file is read
under its lock and any read error but a missing file stops the change, so an I/O error never
writes the held work away; a file that does not parse is moved aside to `.corrupt-<time>`
(logged) and the work goes on from empty. With no permit guarding the process, or on a boot
that is not normal (a switch's trial), nothing reads or writes that file.
Routes answer 503 with a plain message.

**Op ids.** A mail send also registers its op id (`mail:<idempotency key>`) with the witnesses
before it goes out (`beginOutwardSend`: the permit core's `registerOps` and `beginSend`) and
reports how it ended (`sent`, `not-sent` when it surely never left, else `unknown`). An op an
earlier holder registered and never reported is never sent again: the mail row settles
`unknown` ("check the Sent folder"), and `walnut leader status` lists it
(`local/leader-switch/unresolved-ops.json`). Outcomes the witnesses report go into the data
(`cache/leader-op-outcomes.json`, 30 days), which outlives their entries. Doors with no stable
key of one logical send (unsubscribe clicks, calendar creates, pushes, plugin writes, task
sync) check the permission only: a once-ever id would refuse a legitimate retry for good.

Each door call is written to `local/leader-switch/may-act.jsonl` (rotated at 4 MB) with the
permission's changes, which is how the rehearsal proves that the two machines never act at the
same time.

## Downtime

Measured by the rehearsal (from the old leader's stop to the new one ready with its doors
open) on clouddev, under a 5-minute load of about 90 on 48 cores. The final batch only reads
what changed since the last periodic batch and the promotion is one rename, so the home's size
counts mostly through its number of files; the two server starts are the rest. A standby that
is behind (its last batch over 5 minutes old) is refused at preflight: its final batch would
make the downtime long.

| Home | Downtime |
|---|---|
| small (a few hundred files) | 8.2 to 8.8 s |
| 20 GB of leader data (80 files of 256 MB, 20,000 small files, the databases) | 28.2 s: final batch and its second look 4.1 s, promotion 11.8 s (most of it making every file writable, made parallel since), trial 8.4 s, real start 3.8 s |

## Rehearsal

`bun scripts/leader-switch-rehearsal.ts <work dir> [--gb N] [--kills] [--trials] [--flag-off] [--restarts] [--console] [--all] [--keep]`
runs on any Linux dev box (in a Walnut dev container: `walnut-dev run bun ...`). It builds two
machines and three witnesses in `<work dir>`, starts A on a synthetic home with tasks, notes,
a plugin's files and a routine, keeps a standby copy at B, drives writes through A's API, runs
the real `walnut leader switch`, and prints one line per check: every acknowledged write on
B by content, op ids replayed on B apply none twice, the routine's slots each fired once, the
two machines' permission logs never overlap, A started by hand (online, and with every witness
unreachable) runs as a standby that names B, answers a write `handed_over`, writes no door line
and leaves its home's hash unchanged, B's writes come back with `--back` and A leads again
(its standby stopped by the switch), B started by hand then is a standby naming A. `--kills` kills the command at each
step (after the handover, during the final batch, during and after the promotion, during the trial,
between the commit's majority and its marker, after the commit) and resumes it; `--trials`
breaks the copy (a corrupt database, a missing note, an old program) and expects a rollback;
`--flag-off` checks that nothing of it runs with the experiment off; `--console` runs the old
leader's console ([its rehearsal](./leader-switch-console.md#rehearsal)). Its test is
`tests/e2e/leader-switch-real.test.ts`. The standby copies and promoted homes are read-only, so at
the end the run makes `<work dir>` writable again and removes it when every check passed (`--keep`
keeps it); a failed run keeps it, writable, as evidence.

## Not built yet

- **Remote transports**: witnesses on other machines, a remote `SwitchSide` (start and stop a
  server on another machine), the standby transport over the network. What changes then: the
  witness transport (`local-witnesses.ts` becomes a request over the links), `LocalSide`
  (`side.ts`), the standby target's transport (task aead7731), and the path rewrite (the new
  home's path differs per machine). The flow, the records, the marker, the boot rule and the
  doors stay.
- **Daemons key everything by the home's path** (triggers, plugin jobs, the leader book): a new
  leader on another path is a new Walnut to them. On one computer the two homes are two paths,
  so the rehearsal's triggers and plugin jobs do not move with the switch (no daemon runs in
  it); moving them needs the daemon to key by the Walnut's id (the session daemon is not
  changed in this phase).
- **Operation ids registered at the witnesses before an outward send**: the permit core has
  them (`registerOps`, `beginSend`, `reportOutcome`), no send path calls them yet. For this
  manual switch they add nothing the data does not carry: the old leader is stopped and its
  final batch is complete, so a send claimed and not settled at the stop is in the copy's
  ledger and listed as "outcome unknown" (mail; its reaper never sends a `sending` row again).
  They matter for an automatic takeover, where the copy may lag.
- **Old leader under a service launcher**: the old home now comes back as a standby, so a
  launcher's restart no longer loops. The switch still stops the old leader with a signal; a
  launcher that restarts it during the switch gets a standby on the port, which a rollback's
  start of the old leader (`side.ts`) stops first, and the launcher may then start another.
  Stopping it through the launcher is the next phase's.
- **The standby takes no data**: it answers who leads and nothing else. The old machine's
  console is served by its host replica of the new leader instead
  ([The old leader's console](./leader-switch-console.md), whose own list of what is not built
  yet starts with the new leader taking the old machine as a host by itself).
- **A switch back with a launcher** (known risk, left for the cross-machine phase): the switch
  stops the old home's standby right before the promotion, and a launcher that restarts what it
  sees stop can start the standby again in that gap. It then holds the port the trial and the
  new leader need (their start fails and the switch rolls back), or runs on the promoted path.
  The fix is to stop it through the launcher, which this phase does not touch.
- No Settings screen (it needs the user's approval of the design).
- Backups are not a door: a stopped old leader backs up nothing, but a server that lost the
  permission while running keeps its backup schedule.
