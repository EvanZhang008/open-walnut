# The manual leader switch

Moves the leader of a Walnut (the machine that writes its data, runs its timers and triggers
and sends anything outward) to another machine by hand, with nothing lost, nothing sent twice,
and a way back. Code: `src/core/leader/switch/`, CLI `walnut leader`. Behind the experiment
`switchable_leader` **and** a `leader_switch` section in config.yaml; with either missing nothing
of it runs, no boot path changes and the outward doors are not checked.

It joins two earlier pieces: the [standby copy](./standby-copy.md) (the whole data folder,
copied in batches of one moment) and the [write permission](./leader-write-permission.md)
(numbered records kept by a fixed majority of witnesses).

**The flow runs both machines on one computer** (each "machine" is a home, a standby folder and
a machine-id file, `LocalSide`); the witnesses may be directories there or the Walnut service of
another machine ([Witnesses on other machines](#witnesses-on-other-machines)). The remaining local
pieces (`LocalSide`, the standby transport) are replaced by remote ones in later steps; the flow
and its rules stay.

## Setting it up

```yaml
experimental:
  switchable_leader: true
standby:
  dir: /srv/b/standby          # the batches of the current leader land here (the other machine's standby_dir)
leader_switch:
  witnesses:
    - { id: w1, dir: /srv/witness/w1 }         # a directory on this computer
    - { id: w2, dir: /srv/witness/w2 }
    - { id: w3, host: dev-box }                # the Walnut service of another machine
  machines:
    - { id: machine-a, home: /srv/a/home, standby_dir: /srv/a/standby, port: 3456 }
    - { id: machine-b, home: /srv/b/home, standby_dir: /srv/b/standby, port: 3460, account_home: /home/b }  # optional: paths under it move (Paths)
  back_window_hours: 168
```

`walnut leader witnesses init` sets up each witness once (a directory here, or the record on the
witness machine: [Witnesses on other machines](#witnesses-on-other-machines)). A machine's id is its one
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
5. **promote**: the copy becomes the new home (`promote.ts`; `promoted.json` goes into the copy
   first). With no folder at that path it is one rename, so the home is marked from the instant it
   exists. A folder already there (the first switch's target holding this machine's daemon state,
   a switch back's handed-over home) is swapped around this machine's daemon runtime places
   (home manifest `isMachineRuntimePath`: the journal root, leader book, streams and samples an
   installed daemon keeps in `<home>/tmp`): everything else goes to `<home>.before-<switch>`, the
   copy's entries come in, and the daemon's places never move, so it keeps writing them at the path
   it reads while the swap runs (moving them away and back would lose what it wrote by path in
   between). The old `local/` goes last and the copy's first, so the home holds a marker but for
   two renames. Demoting a failed trial swaps back the same way. Its read-only modes become read-write, and
   the old machine's paths are rewritten by the rule table ([Paths](#paths)), among them the
   applied-ops ledger's `home` column (without it every op id the old leader applied would
   apply again on the new one: the rehearsal shows it) and `standby.dir` (the new leader's
   batches go to the old machine's standby folder, for the switch back). Sends the old leader had begun and not settled
   (mail rows `sending` or `unknown`) are listed as "outcome unknown".
6. **trial**: an offline self-check (every file of the batch at its size, every database
   through integrity_check with the old home's row count, no path of the old machine left
   that no rule keeps: [Paths](#paths)), then the new leader starts with `WALNUT_LEADER_TRIAL=1`: it never asks for the
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

### Hosts follow the new leader

A host keys each Walnut by the data dir path its server speaks from (`walnut-scope-core.ts`). A
new leader on another path, or another machine, would be a new Walnut there: a second trigger set,
a second job set, its own detached records, while the old ones stay under the old path. So the new
leader **declares a move** from the old holder's path, as a moved data dir does
(`src/core/home-move.ts`, [session daemon](./session-daemon.md#a-walnut-has-one-key-on-a-host-whatever-its-data-dir)).
Each host makes the new path an alias of the Walnut's first home there and refuses the old path
for good (`walnut_home_busy`). From then on its trigger epoch, seq and memory, plugin jobs,
detached records, copies, host server and bridge are the new leader's, with one copy of each.
The hosts and the daemon twins are unchanged.

- **Where the old path comes from**: the old leader's own server. `GET /api/leader/status` answers
  `homeOnHosts` (its data dir exactly as it sends it to hosts, plus the former homes its
  `local/home.json` keeps). The preflight stores it in the switch state and refuses a leader that
  does not say it. Before the commit start the switch writes it into the new home's
  `promoted.json` (`fromHomeOnHosts`, `fromFormerHomes`, with `to` and `handover`). The
  `machines` entry is not used: it is a person's spelling, resolved, and a host keys the exact
  string. The handover record is not used either: the new holder's renew replaces it at the witnesses.
- **When** (`src/core/leader/switch/moved-home.ts`): the permit guards the process (not a trial),
  the home has no handed-over marker, `promoted.json` names this machine, and the switch
  committed. That means `led`, or, in the commit start, its own record above the handover standing
  on a majority. Until then every host connect holds its commands, so no host hears the Walnut
  from the new path first: that would give the new path a record of its own, and the move could
  never be taken there. One wait lasts at most twice the longest a good commit takes
  (`2 x (validMs + witnessMarginMs)`, 124 s by default). Past that, the connection attempt fails
  with `HomeMoveHeld`: no frame is sent, its backoff retries with a fresh wait, and a Walnut Health
  item ("Hosts wait for the leader switch to be confirmed") stays until a later attempt declares. It
  is never answered as "nothing to declare". A permit that stops before its commit stands settles
  the wait with nothing. An ephemeral server never declares. Declared with `in_process_daemon` off
  too, on every connect.
- **Not built: a candidate's own link to remote witnesses.** The commit start reaches a witness
  through its daemon link as a follower stream. A host routes that only for a socket that described
  its Walnut, and only to a follower of that same path. Before the move is declared, the new path
  is neither (case (s2) of the twins test). With every witness remote and reached only over daemon
  links, the commit cannot stand. The switch then rolls back at its commit deadline, which is safe:
  the old leader leads again. It needs a link that does not go through the Walnut's follower (the
  host-dialed door of phase 5a, or a port stream to the host's service). The home's
  record keeps the switch id (`switchId`), so restarts and later moves on that machine go on by the
  usual rules.
- **Switch back**: the same rule the other way. The fresh copy at the old machine's path declares
  the other machine's path, and the host flips where the Walnut is now. There is no `contested`,
  because the declaration names where the host has it now.
- A copy on another machine with no switch record, a record not committed, or one naming another
  machine declares nothing, as before. With the experiment off `judgeHome` is the rule it always
  was (pinned by a verbatim copy in `tests/core/home-move.test.ts`).
- The handed-over standby must never connect to a host as this Walnut (it would claim the lead
  and drain the host's journal into the old home). `tests/core/leader/switch/standby-no-host-link.test.ts`
  guards it.

Tests: `tests/core/home-move.test.ts`, `tests/core/leader/switch/moved-home.test.ts`,
`tests/core/leader/primary-leader-home-moves.test.ts`, and case (s) of
`tests/providers/daemon-home-alias-twins-e2e.test.ts` on both twins. That case covers one set,
job set and copy, all the new leader's, nothing keyed by the new path, a fire in delivery at the
aliasing moment taken once by the new leader with the old socket refused, and the switch back.

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

## Paths

A home promoted on another machine, another OS or under another account still holds the paths its
stores wrote on the old one: the old home (`/home/old/.open-walnut/...`) and the old account home
(`/home/old/...`, from `account_home` of each `machines` entry, else its `env.HOME`). The promotion
rewrites them by a rule table, and the trial's self-check scans for what is left.

**The scan** (`src/core/leader/switch/home-paths.ts`) reads every file of the home: config and other
YAML by key, JSON by key path, JSON lines by line and key path, SQLite by `table.column` and row (JSON in
a column by its key path too), other text by line. A file over 16 MB is listed as not read, binaries are
skipped, a database's `-wal` is read through the database. A path is a root followed by a separator or the
end of the path: `/home/a` is not in `/home/ab/x`. Unicode, JSON escapes (`\u00e9`, `\/`, `\\`) and
Windows-style roots (`C:\Users\a`, either separator after them) are handled. Measured on a synthetic home
of 22,004 files and 255 MB (20k notes, 2k thread files, a 200k-line log, a sessions database of 50k rows, a
tasks database of 20k rows; `WALNUT_HOME_PATHS_BENCH=1` on `tests/core/leader/switch/home-paths.test.ts`,
a dev box at load 90 on 48 cores): the whole home in 4.4 s (72,641 hits); the trial's scan, which skips
what a `keep` rule decides whole, 1.7 s (it still reads the tasks database's JSON). In the rehearsal the
trial's scan took 53 ms of the 8.4 s downtime.

**The rules** (`src/core/leader/switch/home-path-rules.ts`), the first that covers a place decides it:

| Where | Rule |
|---|---|
| `config.yaml`, `config/` | rewritten, both roots: a setting the leader follows on its own machine (a model, a key file, a source checkout) is the same place under the new home or account home. Kept: `leader_switch` (names both machines), the host-keyed places (`standby.walnut`, `usage.proxy_log_dirs`, `external_session_import.excluded_cwds`). `standby.dir` is set to the old machine's standby folder |
| `cache/applied-ops.sqlite` | the `home` column of this home's rows moves to the new home (rows already there win); another home's rows are kept |
| `tasks/tasks.sqlite` | a path in the home inside a task's or a project's JSON (`cwd` of Main and Ask, a routine launch) moves to the new home; a path in the account home (a repo, a task folder) is kept: the work and its files stay on the machine that ran it |
| `cron-jobs.json`, `triggers/`, `hooks/`, `actions/`, `commands/`, `skills/`, `CLAUDE.md`, plugins' files | a path in the home moves (a trigger's check script, a plugin's data); a path in the account home is kept |
| sessions, subagent runs, folder lists, `hosts/`, `workspaces/`, `tmp/file-history/` | kept: where a session or a subagent ran, on the machine that ran it (its transcript and folder are there; a sweep that removes left folders must find them where they were made) |
| notes, memory, histories, inboxes, threads, boards, logs, usage | kept: text a person or an agent wrote, or a log; nothing follows it |
| a copy beside a store (`config.yaml.bak`) | as the store |
| machine or rebuildable data (manifest) | never in a batch, so it does not travel |
| a top-level file no store of Walnut names | the user's own file in the vault: kept |

Anything else (a store no rule decides) fails the trial with the file, the key or row and the path, and the switch rolls back.
The ratchet `tests/core/leader/switch/home-path-ratchet.test.ts` fills a synthetic home with the real writers (task and
session stores, the config writer, the ledger, the folder lists), takes a real batch, promotes it to another home under
another account home, and fails on a hit no rule decides, on one the promotion should have rewritten, on a rule nothing meets
any more, and on a leader-data store of the manifest that is in no rule and not in `NO_PATH_STORES`.

## Rehearsal

`bun scripts/leader-switch-rehearsal.ts <work dir> [--gb N] [--kills] [--trials] [--flag-off] [--restarts] [--paths] [--console] [--all] [--keep]`
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
breaks the copy (a corrupt database, a missing note, an old program, an old-home path in a store
no rule decides) and expects a rollback; `--paths` moves a home to another HOME prefix and checks
what the [path rules](#paths) did (the main run does too, and scans both homes after each switch);
`--flag-off` checks that nothing of it runs with the experiment off; `--console` runs the old
leader's console ([its rehearsal](./leader-switch-console.md#rehearsal)). Its test is
`tests/e2e/leader-switch-real.test.ts`. The standby copies and promoted homes are read-only, so at
the end the run makes `<work dir>` writable again and removes it when every check passed (`--keep`
keeps it); a failed run keeps it, writable, as evidence.

## Witnesses on other machines

A witness entry is `{ id, dir }` (a directory on this computer) or `{ id, host }` (the Walnut service
of another machine). `host` is a `hosts` alias of config.yaml, or, when it is none, the machine id a
connected host reported in its hello. The list stays FIXED and a majority of it decides.

**One list, one meaning on every machine.** The config travels with the home, so on the other machine a `dir` is a different
directory with a different record: one witness id would be two witnesses. A list therefore has either only `dir` entries (one
computer) or only `host` entries; a `dir` beside a `host` is refused when the settings are read. Two entries that name one place
are refused too (`host` compared ignoring case; an alias and a machine id naming one machine are found when the witnesses are set
up: the first setup on a machine claims it, and a second witness id there is refused with 409, `walnut leader witnesses init` also
resolves each `host` and reports two that name one machine, and the claim is taken under a lock so two setups at once make one).

**The route.** A host's Walnut service (`walnut web --replica`, the host's one service) answers
`POST /host-api/witness/request` (one permit request, one reply) and `POST /host-api/witness/setup` on
its leader door, the door only the host daemon's relayed streams reach
(`src/replica/leader-door.ts`, `src/core/leader/switch/witness-route.ts`, the wire in
`witness-wire.ts`). The record is on that machine's disk, `<state dir>/open-walnut/leader-witness/<walnut id>/<witness id>/permit-record.json`
(next to `machine-id`, outside every data home, `machine` class in the home manifest), kept by the
same code as a local witness: one file, one lock, a durable write before each answer.

**Who may ask.** The route answers only a caller that belongs to this Walnut, and the check is ONE
function, `authorizeWitnessCaller` (`witness-route.ts`). Today a caller can reach the door only through the host
daemon's relayed stream from the leader of the Walnut the service follows, and the Walnut id in the body must be
the one the service follows (403 otherwise; 503 when the service does not know its own). When the host-dialed door exists, a caller is authorized by the socket that passed its handshake (both sides prove the
credential's verify key by challenge-response): the door passes the credential's own Walnut and machine ids instead, no per-request token
is made, and that function is the only place that changes.

**When it answers.** A machine serves a witness only when the experiment `switchable_leader` is on (a host's
config is a copy of the leader's) AND an operator set the witness up (`walnut leader witnesses init`): a
witness that lost its record never starts over by itself, so a request alone never makes one. Otherwise
the answer is **404 `not_found`**, byte for byte the answer of a path the service never had (also for a witness that is
not set up, and when the config cannot be read): nothing tells a caller from today's service, and with the experiment off the door
loads none of the permit or switch code (it checks the flag first). 404 rather than 503 because 503 would say "a witness is
here", and a caller gets nothing more from it (any answer but 200 is no answer to the permit client). One witness id per Walnut
per machine: a second `setup` with another id is refused with 409, and a request for an id this machine does not hold is 404.
A body is stored only when it is exactly a permit record (every field checked, unknown fields refused, 400 otherwise).

**Setup only from nothing.** A setup makes a witness record from nothing, so it is refused while any other witness of the list
may still hold records: a witness that lost its disk must not come back as a fresh one beside witnesses that still hold the
lease (it would say yes to a second machine, and that machine plus a witness with only an old record would be a majority while the
first still leads). Every setup therefore carries what the caller saw at each OTHER witness of the list (`none`, `blank`, or
`record`); the witness refuses (409) one that is missing, incomplete, or shows a record, and `walnut leader witnesses init` does not
send one it knows will be refused. A lost witness rejoins through a list change (permit/store.ts), which is not built for the
switch yet; until then it stays unset and the list runs on its other two. The setup is for the first time a list is made.

**The transport.** `src/core/leader/switch/witness-transport.ts` is the `PermitTransport` for both kinds of
witness. A remote request is one HTTP request on a stream the host daemon relays (the leader server's link: `link(host)`,
`openStream('follower', 'replica')`, `requestOver`). That pooled link is a full daemon connection (it describes this Walnut to the host:
slice, leader.configure, the offline drain), so a server opens it only once it HAS LED (the runtime's `daemonLink` gate is false until the
first lead and in a trial start, and stays open after, for the renew, a handover, a cancel and the release at a stop). A start that is
still waiting for the permission, one the witnesses refuse, a standby, `walnut leader status` and the switch command's preflight
open none: they reach a remote witness only through a registered reach. Before it leads, a server whose witnesses are all remote therefore
reaches none of them (see the candidate gap below), and a start refused after reading closes any link this module opened before it
goes on as a standby (`closeWitnessLinks`, called by `boot.ts`; the gate means there is none). `walnut leader witnesses init` sets remote
witnesses up through the running leader server (`POST /api/leader/witnesses/init`, 409 unless it holds the permission); it reads the witnesses
first and sends the evidence above. Each read carries a round number that the answer echoes: a reply is handed on only when it is newer than the last one handed on for that witness, so one that overtook a
newer reply (late or reordered over a slow link) never takes the reading back. (A witness whose round trip is longer than the gap between looks is still heard, with answers as old as its round trip.) The reply is handed to the client on a later tick; each request
has a **15 s timeout** (the renew period) and a reply after it is dropped as a lost one; a reply counts only when it names the
witness asked and the request sent; at most 4 reads and 16 proposals are open to one witness at once; nothing is retried here
(the client retransmits, and a duplicate is a no-op at a witness). The permit core is safe under a lost,
repeated, late, reordered or redelivered reply: the model check
(`tests/core/leader/permit/`) runs every machine through this transport, over a link that delays, drops,
duplicates and reorders, with timeouts, and with old replies redelivered after newer ones.

**A slow witness.** The leader's lease is `validMs - holderMarginMs` = 58 s from when it SENT a renew, and it renews every
15 s. A reply counts only while its record is the client's open proposal, and the next renew replaces that proposal 15 s after
it was sent, so a majority's round trip must stay **under the 15 s renew period**: each request times out at 15 s, and a witness slower than
that is as good as lost. With two of three witnesses out of reach the leader then has no majority (the same as the witness being down).
Under it, just before each answer the leader has `43 s - roundTrip` left, above the 15 s an outward send needs
(`minSendRemainingMs`) for every round trip under 15 s. Measured in the simulated world through the real transport, a leader that reaches
two of three witnesses and the slower one has this round trip:

| round trip of the slower majority witness | lease left just before the next answer | may act | outward sends allowed |
|---|---|---|---|
| 10 ms | 43.0 s | always | always |
| 10 s | 33.0 s | always | always |
| 14.9 s | 28.3 s | always | always |
| 20 s, 30 s, 40 s | none | never (no renew is ever chosen) | never |

Over real loopback doors (a leader door behind a TCP socket per witness, records fsynced on disk, three witnesses, no daemon or ssh hop) the
renew round trip measured **median 78 ms, p95 403 ms, max 421 ms** over 40 renews (the poll that reads the outcome adds up to 20 ms; fsync dominates).
A real host link adds the daemon relay and the network on top: a few hundred ms to a few seconds is far inside the 15 s.

(The same holds with no timeout at all: the open proposal is replaced first. The lease math alone would allow a round trip up to
28 s for outward sends and 43 s for acting, but the core never uses a reply that late. Counting a late ack of an earlier renew would
widen this and is safe, since the witness took exactly that record, but it is a change of the permit core, not made here.)

**Readers.** The switch command (preflight, the handover, the commit wait, a cancel) and `walnut leader status` open no host link: with a
remote witness in the list they read the witnesses through a running leader server of this Walnut, `GET /api/leader/witnesses` (this machine
only; the old leader's server before the handover, the new leader's commit start after it; a trial start answers 409). With none running they
say so ("the witnesses ... are on other machines and only a running leader server can read them") and read nothing. Local witnesses are read
in the command's own process as before. A standby still reads remote witnesses only through a registered reach.

**A candidate has no link yet.** A machine that is not the leader yet (the new leader's trial and commit start) has no link to any host: the daemon opens a stream to a host's
service only for a server that has spoken for a leader home, a host's service follows the OLD leader's data path, and the trial
column turns `local-daemon` and `host-network` off. Such a process reaches only its local witnesses, so with three remote
witnesses a candidate gets no majority and a switch refuses in preflight. The transport takes any way to reach a host
(`addWitnessReach`, tried before the daemon link): the host-dialed door of the leader (the "5a" door, which carries
`/host-api/witness/` calls when it allows that prefix) registers one for each host that dialed it. A candidate cannot use the
leader's door, so it needs one of: a door of its own that hosts dial (the standby serves it, hosts list it), or the commit start opens
the host links before it renews (an outward configure the doors list must then cover). The first needs 5a's door on a
non-leader, the second a decision; neither is built here. A relay through the old leader is not an option today:
the two machines have no route to each other.

**What that means until the direct link exists.** A server opens a leader-describing link only after it has led, so a
list of witnesses that are all on other machines cannot be led from or read by a server that has not led yet: a first start waits
(no majority answers), `walnut leader witnesses init` for remote witnesses is refused unless the server already leads (and then the
records exist, so it refuses a setup beside them), and a switch to a machine whose witnesses are all remote refuses in preflight. The
remote witness code, its route, its transport and its tests are in; the first real use waits for the host-dialed door (a
reach for a not-yet-leader). Tests: a real host daemon runtime relays the leader's `follower`/`replica` stream to a real leader door
with the route on it (`tests/core/leader/switch/witness-twin.test.ts`, the standalone twin; the source twin keeps the same relay
rule and is not run there), and a spy on the link module shows no link before the first lead, none for a refused or trial start, and the
link of each host after it (`witness-link-gate.test.ts`).

## Not built yet

- **Remote transports**: a remote `SwitchSide` (start and stop a server on another machine), the
  standby transport over the network. What changes then: `LocalSide` (`side.ts`), the standby
  target's transport (task aead7731). The path rewrite between homes and accounts is [done](#paths);
  whose host the old leader's own local sessions and folders become after a switch is not decided.
  The flow, the records, the marker, the boot rule and the doors stay. The witness transport is
  [done](#witnesses-on-other-machines) except for a candidate's own link to the witnesses.
- **Hosts following the new leader** is built ([Hosts follow the new leader](#hosts-follow-the-new-leader)):
  no daemon runs in the rehearsal yet, so that runs only in the real-daemon test.
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
