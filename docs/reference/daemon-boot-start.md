# A host's daemon after a reboot

Every remote host runs Walnut's session daemon. Started the usual way (over SSH, when
Walnut connects), it does not come back by itself after the machine reboots: plugin
jobs, triggers and cron-armed sessions placed on that host stop until Walnut connects
again. Walnut now makes the daemon a service of the host's own account, with no root
and no step for the user, and Settings > Remote Hosts says on the Daemon row whether
it starts after a reboot, and why not when it does not.

## What starts it, in order

`walnut daemon install --yes` with no `--scope` picks the first of these the account
can have (`src/providers/daemon-service-scope.ts`):

1. **A systemd user service**, when a systemd user manager answers for the account and
   linger is on, or the account may turn linger on itself
   (`loginctl --no-ask-password enable-linger <user>`; polkit's `set-self-linger` allows
   it without a password on some distributions). Walnut never uses sudo for this.
2. **The account's crontab**: one `@reboot` line, tagged `# open-walnut-daemon`, that runs
   the supervisor script `~/.local/share/open-walnut/daemon/daemon-boot.sh`. Used when the
   account may use `crontab` and a cron daemon starts at boot (its systemd unit is enabled,
   or one is running on a system without systemd). The script restarts the daemon on every
   exit (1 s after a clean one, 5 s after a failure, and stops after 5 failures in 60 s),
   reads itself again on each restart (so an update is the new script plus the daemon's own
   update exit), ends when `daemon-boot.stop` is beside it, and never hands its lock to the
   daemon. Every other line of the crontab is kept byte for byte.
3. **Nothing**: the install fails with what each one lacked, and the one step an
   administrator could take (`loginctl enable-linger <user>`, or enabling a cron daemon).

A Mac starts the daemon as a LaunchAgent, which runs when the user logs in.

Either way the service runs the staged daemon binary
(`~/.local/share/open-walnut/daemon/versions/<sha256>/daemon --service`) and keeps its
state (triggers, hooks, plugin jobs, the session registry) in that install root, never in
`/tmp`, which a reboot may empty. Each install or update keeps the version it runs and the
one before it, and removes older ones that no process runs.

## What Walnut does by itself

At each connect to a Linux host (and every 6 hours while connected) the server asks the
host, in one SSH round trip that reads only (`src/providers/remote-boot-start.ts`), which
service config is there and whether it starts at boot. When none is, and the daemon can
hand its sessions to a service (`service-handover-v1`), it runs
`walnut daemon install --yes` on the host with this build's daemon binary (the one already
there on a host that runs the binary, else uploaded in checked chunks). The running daemon
hands its sessions over and exits, the service daemon adopts them, and the connection's
reconnect finds it. A failed attempt is recorded on the host
(`~/.local/share/open-walnut/daemon/boot-setup`): the same build is not tried again for a
day, another build not for six hours. A failure that would leave a service config with no
daemon behind it removes that config, so Walnut runs the daemon the usual way again.

A `walnut daemon uninstall --yes` run on the host is the user's choice: it leaves
`result=removed` in that marker, and Walnut does not set the host up again until someone
installs the service there.

It never replaces a service config that is already there, never sets up the Mac itself or
the cloud box, and never runs from an ephemeral server. It is off with automatic host fixes
(`WALNUT_HOST_AUTOFIX=0`, or `hosts.<name>.autofix: false`; the host is still asked, so
Settings can say so) or with `WALNUT_DAEMON_BOOT_START=0` (nothing is asked at all; the test
setup sets it, so no test reaches a real host this way).

Updates follow the service: a host with a user service or the cron boot script gets each
new daemon build as `walnut daemon update --yes --scope <user|cron>`.

An install or update never stops the old daemon for one that cannot serve. Before any
service change, `walnut daemon install|update` starts the new executable as a daemon in
throwaway directories of its own (`src/providers/daemon-boot-proof.ts`) and refuses, with
nothing changed, when it does not listen within 60 s or does not stay up. After the swap
the new daemon has 60 s to answer, else the previous config is put back. On a Mac every
bootout waits until launchd lets the job go, and a bootstrap asks again for 30 s
(`src/providers/daemon-service-launchd.ts`); every failed install, update or restart of a
service that ran before ends by loading the LaunchAgent or starting the unit again when
nothing runs it, and a cron rollback whose supervisor gave up starts a new one. The server
checks the same after every update it starts (`src/providers/daemon-update-tail.ts`). A new
daemon that served is then watched for 15 minutes (`src/providers/daemon-update-probation.ts`):
one that is gone, or started again twice, gets the config from before back from the copy kept
in the install root (`update-before/`, which a reboot does not clear), and that build is not
run there again for a day. Only an update that changed the service config is watched. A put-back
holds the install lock until the config it put back is loaded, so a later update never finds the
service half restored. No later update starts while the 15 minutes run, a reboot that ended
the watch early included: it is asked again once they are over, so the copy kept for the build
before is never taken by the next update. Copies a reboot left behind are used only while their probation still had
time left, or, with no probation yet (a power loss in the middle of the update), for 7 days unless
a daemon kept serving there for more than an hour after the update.

## The launcher (experiment `service_launcher`)

With the experiment on, the service config runs a small POSIX sh launcher instead of the daemon
(`src/providers/service-launcher-script.ts`; dash and the Mac's bash 3.2 run it, and it loads no
Walnut code). The systemd user unit runs `walnut-launcher.sh` with `Restart=always` and no start
limit, the LaunchAgent runs it with `KeepAlive`, and the cron start keeps it in `daemon-boot.sh` with
the @reboot line and a second line every minute (it does nothing while a launcher holds the lock).
Its own files are in `launcher/` in the install root:

| File | Written by | What |
|---|---|---|
| `state` | the launcher only | `current`, `good`, `phase` (committed, trial, probation), `since`, the builds |
| `request` | `walnut daemon update` | a switch to `exe` (`prepared=0` until the old daemon prepared) or a put-back |
| `result` | the launcher | the answer to a request: committed, rolledback, refused, failed |
| `heartbeat` | the daemon, every 5 s | `<epoch> <busy until> <pid>` |
| `ready` | the daemon | its pid, once its sessions are adopted, its port listens and it asked itself over that port (hello as itself, status of a session it adopted) and got the right answers |
| `leaving` | the daemon | its pid, just before a planned exit (it prepared for an update an older Walnut runs): no crash |
| `rollback`, `bad` | the launcher | the last put-back and why; the versions it refuses for a day |

The launcher restarts the daemon when it exits (1 s after a clean exit, then 1 to 30 s), and ends and
restarts one whose heartbeat is over 60 s old unless the daemon said it is busy (at most an hour).
An update stages and proves the new daemon as before, writes the request, asks the old daemon to
prepare, and waits: the launcher writes the new version as a trial, stops the old daemon, starts the
new one and commits it when `ready` comes. A trial that exits or is not ready in 90 s, or a second
failure in its first 15 minutes, puts the good version back: the launcher first runs the registry's
stop script (`detached/stop-detached.sh`, `src/providers/detached-registry.ts`) for the work the new
version started that an older one cannot follow, refuses that version for a day (and writes
`update-probation.failed`, which the update runner already reads), and the daemon's hello carries
the put-back to Walnut Health and to the host's Session helper row in Settings. A trial found at
start (the machine lost power mid-switch) is the old version again, without refusing the new one; a
trial cut off by a stop (SIGTERM) is the old version again too, its request left for the next
launcher, which tries it again (a third cut-off is the version's failure, and a prepared request
older than an hour is dropped). `walnut daemon restart` under the cron launcher writes `leaving`
for the daemon it ends, and an update waits for a busy trial as long as the launcher gives it. A trial that still beats and says it is busy (a long adoption) gets
up to 15 minutes instead of 90 s, and any exit in the probation the daemon did not announce counts.
A tick 10 s or more off the one before (a sleep, a paused VM, a clock change) moves the trial and
probation clocks by the gap and gives the heartbeat 60 s more, so a wake ends nothing. A current
version that is gone from disk is replaced by the good one, else the seed. An update whose unit or
job restarts marks its switch prepared only after the restart.

Once a version is the good one, the daemon removes the staged versions nobody needs: it keeps the
current, the good and the one a pending switch asks for, any version a process runs, and any staged
in the last hour (an update may be about to ask for it). Linux only, as the update's own prune. Before
each start the launcher removes `detached/adopts`; a version that becomes ready without writing it
(older than the detached-work registry, `src/providers/detached-registry.ts`) gets the registry's work
ended by its stop script, as at a put-back.

One launcher per install root: an flock (perl's flock on a Mac, which has no flock(1)), never
handed to the daemon. A launcher that comes back while its daemon runs (pid and start time match)
watches it on. SIGTERM (a stop of the unit or job) stops the daemon, then the launcher.

Older Walnuts keep working with it: the unit and plist keep the `"<file>" "--service"` shape and
the cron launcher keeps the boot script's header and `EXEC` line, so an older update puts its daemon
back in the launcher's place (the launcher follows an `EXEC` it did not write, and stops its daemon
when its script is no launcher any more). An update that finds a plain config (an older Walnut ran
in between) forgets the launcher state left from before (`state`, `request`, `result`, `ready`; the
refusals and the last put-back stay), since its versions are not what runs. With the experiment off,
the next daemon update writes the plain config again, whole, also over a launcher unit an older
Walnut put its daemon in; a host whose daemon is current keeps its launcher until then.

## One Walnut service (experiments `in_process_daemon` and `service_launcher`)

Under the launcher, `--service` can run the host's one Walnut service instead of the daemon: one
Walnut's follower server holding the daemon runtime in its own process
(`docs/reference/session-daemon.md`, "The Walnut service on a host"). One file in the install root
decides it:

| File | Written by | What |
|---|---|---|
| `service-mode.json` | `walnut daemon install\|update` only | `{ v: 1, home, exe }`: run the follower of `home` as the service, for the version `exe` only |

`--service` reads it before it loads anything else (`src/binary/service-entry.ts`). No file, another
version's file, no follower spec for `home` under `host-server/`, or any other doubt: it runs the
daemon, with the reason in its log. Because the file names one version, a launcher that puts an
older version back runs that one as a daemon, and an older binary never reads the file: a rollback
needs no step of its own.

`walnut daemon update --serve <home>` writes the file for the version it stages (and its proof boot
starts that file as a service in throwaway dirs, `daemon-boot-proof.ts`); `--no-serve <home>` removes
it; an update with neither carries the mode over to the new version. Only the Walnut whose `home` the
file names may change it: another Walnut's `--serve` or `--no-serve` gets `not_service_owner` and the
mode stays. The leader passes these words itself (`src/providers/one-service-mode.ts`); a person
never needs to.

The service, like a daemon, says where its door is in the daemon dir: `daemon.port`, `daemon.pid`
(the service's pid) and `daemon.stamp`, `<pid> <start time>` of that pid
(`src/providers/daemon-door.ts`, written before the port file). A leader's daemon checks over SSH
(the start, update and isolation scripts) trust `daemon.pid` when the stamp names the same pid with
the same start time, whatever its command line, and fall back to the command line patterns when
there is no stamp (a daemon older than the stamp). The stamp is written right after `daemon.pid`,
so a stamp older than `daemon.pid` is an earlier daemon's (an older daemon put back, which never
touches the stamp) and counts as none; on Linux it also carries the boot id. A pid reused by another process fails the start
time check (`src/providers/daemon-live-sh.ts`, `w_stamp`, `w_daemon`).

The service writes the launcher's `heartbeat` and `ready` itself (`src/web/serve-launcher-beat.ts`);
the runtime inside it writes none, so there is one writer. `ready` means the runtime adopted its
sessions, the door answers, and the server answers `GET /api/v1/instance`.

## Commands on the host

```bash
walnut daemon status                      # the installed service, its startup (boot, login, on-demand)
walnut daemon install --yes --executable <daemon binary> [--launcher]
walnut daemon update --yes --executable <daemon binary> [--launcher] [--serve <home> | --no-serve <home>]
walnut daemon restart --yes
walnut daemon uninstall --yes             # removes the service; running CLI sessions keep running
```

`--scope user|system|cron` names a backend; a system unit needs `--sudo`.
