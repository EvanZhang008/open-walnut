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

`walnut leader witnesses init` sets up each witness directory once. A machine's id is read
from `~/.local/state/open-walnut/machine-id` (`WALNUT_MACHINE_ID_FILE` names another file:
the one-machine rehearsal only); it is the holder id of the permission. Until the stable
machine id lands (`src/core/machine-id.ts`, another task) the file is read, never made.
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
| `local/leader-switch/handed-over.json` in its home | **refuses to boot**, with or without witnesses, **and with the experiment or the section gone**: "this data home was handed over to machine X ... it never leads again" (or "a switch is under way: --resume or --cancel") |
| `local/leader-switch/promoted.json` not yet `led` (a standby copy the switch is still making into this home) | refuses, unless it is the switch's own trial or commit start |
| another leader server of this machine holds the instance lock | refuses |
| a majority of witnesses names another machine | refuses |
| a handover to this machine it was not told to commit | refuses ("`walnut leader switch --resume` finishes it") |
| its own record of this process, or none at all (the very first leader) | leads; renews every 15 s |
| a record an earlier process of this machine wrote (a restart, or the old leader's handover after a switch rolled back once its server had stopped) | **boots with every outward door closed** until that record runs out at the witnesses (up to a minute), then grants itself and leads |
| no majority answers | **boots with every outward door closed** and keeps asking every 5 s |

Why refuse in the first rows and not in the last: a refused home is known not to be the data
home any more (booting it would take writes into a dead copy, and there is no read-only mode).
A home without the marker was never handed over (the marker is written before any handover
record), so its data is the newest there is; refusing would take Walnut down whenever two
witnesses are unreachable. While its doors are closed it sends nothing, fires no routine and
claims no trigger. An ephemeral server never asks the witnesses (its config is the user's),
unless `WALNUT_EPHEMERAL_LEADER_SWITCH=1`.

`resolveServerRole()` and `boot-policy.ts` are unchanged: the permission is checked beside
them, not inside.

`GET /api/leader/status` (mounted only while the permit runs): version, machine, trial or not,
and the permission (state, may act, time left, record).

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
   witnesses and acts no more (asked through `POST /api/leader/handover`). While it runs it
   may still cancel it.
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
   permission, so every outward door stays closed; it loads no plugin, runs no standby,
   reconciles, recovers and picks up no session and does what an ephemeral server does not
   (no git pull or commit, no org autostart or duties); its version must read the data, the
   old home's newest task and a note must read back through its API. Then it stops. A
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

### `--back`

`walnut leader switch --back` from the new leader's home, within `back_window_hours`
(default 168) of the switch: a normal switch to the machine named in `history.json`. The
changes made since come back by the standby batches the other way (the new leader's
`standby.dir` was pointed at the old machine's standby folder at the promotion), so the
switch back needs that copy to be recent too. The handed-over old home is moved aside
(`<home>.before-<switch>`, kept, still marked) and the fresh copy takes its path.

**What a switch back cannot undo**: anything already sent outward (mail, pushes, a plugin's
posts), and the time the new leader's routines already ran.

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
| someone starts the old home by hand | it refuses to boot, experiment on or off | the marker's message |
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
on disk and one push says what waited; a remote delete, list rename or lead wake waits for the
doors to open (in memory: a restart while closed drops those three; the sync tick retries a
delete for trackers that have it). Routes answer 503 with a plain message.

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

`bun scripts/leader-switch-rehearsal.ts <work dir> [--gb N] [--kills] [--trials] [--flag-off] [--all]`
runs on any Linux dev box (in a Walnut dev container: `walnut-dev run bun ...`). It builds two
machines and three witnesses in `<work dir>`, starts A on a synthetic home with tasks, notes,
a plugin's files and a routine, keeps a standby copy at B, drives writes through A's API, runs
the real `walnut leader switch`, and prints one line per check: every acknowledged write on
B by content, op ids replayed on B apply none twice, the routine's slots each fired once, the
two machines' permission logs never overlap, A started by hand refuses online and with every
witness unreachable, B's writes come back with `--back`. `--kills` kills the command at each
step (after the handover, during the final batch, during and after the promotion, during the trial,
between the commit's majority and its marker, after the commit) and resumes it; `--trials`
breaks the copy (a corrupt database, a missing note, an old program) and expects a rollback;
`--flag-off` checks that nothing of it runs with the experiment off. Its test is
`tests/e2e/leader-switch-real.test.ts`.

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
- **The trial runs as a leader role** with the reductions above; the full quieting (a trial
  placement in `boot-policy.ts`) changes the boot policy and waits for the project lead.
- **Old leader under a service launcher**: a real machine's launcher restarts a server it
  sees stop, and the marker then refuses it in a loop; the next phase stops it through the
  launcher instead of a signal.
- After a successful switch the new machine's standby folder keeps the chunks of the batches
  it received (as large as the home); nothing removes them yet.
- No Settings screen (it needs the user's approval of the design).
- Backups are not a door: a stopped old leader backs up nothing, but a server that lost the
  permission while running keeps its backup schedule.
