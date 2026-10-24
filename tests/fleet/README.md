# The fleet

Walnut's real programs on separate machines, with real links between them,
all on one Mac. Where `tests/helpers/replica-cluster.ts` runs every piece as a
process on this machine (one filesystem, one clock, a direct test transport
instead of SSH), the fleet puts each host in its own Linux container and lets
the Mac reach it the way it reaches a real host: OpenSSH, the daemon deployed
over that SSH, ControlMaster, the tunnel and the bulk lane.

```
the Mac (this machine)                                    a host (Linux container)
  Walnut server child, own data/daemon/tmp dirs,            sshd, user walnut, node,
  own HOME and port (mac-node.ts)                           a mock `claude` on PATH,
    | ssh -F <this run's config> (ssh-identity.ts)          NO daemon until the Mac
    v                                                       deploys one
  fault proxy on 127.0.0.1 ------> port Docker publishes ---> sshd :22
  (tests/helpers/silent-link-proxy.ts)                        |
                                                              v
                                              daemon in /tmp/open-walnut, sessions,
                                              journal + copy in ~/.open-walnut/tmp
```

## Run it

```bash
bun run test:fleet                                   # every tests/fleet/*.fleet.ts
bash scripts/run-fleet-tests.sh tests/fleet/mac-and-host.fleet.ts
bash scripts/run-fleet-tests.sh clean                # remove leftovers and the cached images
DEBUG_FLEET=1 KEEP_FLEET=1 bun run test:fleet        # Mac stderr live; keep the containers and temp dir
```

Opt-in, like the live tier: no other config includes `*.fleet.ts`, so the
fleet never runs in quick, unit, integration, e2e or CI. Without Docker each
file prints a SKIPPED line and the script exits 0 (not authoritative).

Cost: the first run pulls `node:22-bookworm-slim` (kept as
`walnut-fleet-base:node22-bookworm-slim`) and builds `walnut-fleet-host:<hash>`
(a minute or two). After that the Mac boots in about 10 s,
`mac-and-host.fleet.ts` takes about a minute and a half and `host-faults.fleet.ts`
about two (70 s of it is the deploy through the 4 MB cap). Each host container is capped at 1 GB, 1.5 CPUs
and 512 processes. A run holds a Walnut server, its daemons and one container per
host, so run one fleet at a time, on a machine that is not already busy.

The daemon the Mac deploys: the prebuilt Linux binary when `dist/daemon-binaries`
holds one for the container's architecture (`bun run build:daemon`), otherwise the
daemon's source under the host's node. `scripts/run-fleet-tests.sh` builds the
binaries first when the tree has no Linux one (a fresh clone): `host-faults.fleet.ts`
C1 proves the chunked binary deploy, and C2 runs on C1's session. The host has no
bun and no curl, so the bun install step fails at once and is skipped, as on a host
with no way out.

## Upgrades

Three files run released programs instead of this tree's source, and skip with
a SKIPPED line without them:

| File | What it runs |
|---|---|
| `upgrade.fleet.ts` | an old Node release sets up two hosts (daemon, a live session with history, one host's Walnut server switched on), then the Mac's server is replaced on the same data by the compiled walnut file, back to the old release, and forward again; one host's server goes in through a link that cuts large transfers and then drops mid-upload |
| `bare-host.fleet.ts` | the compiled file and a host with no Node, no bun, no curl or wget and no ps: the Mac brings the daemon and the host's server itself, through a link that drops mid-upload too, and the slot's file is started, checked and stopped by hand over a dead daemon's files |
| `companion-upgrade.fleet.ts` | no container: an old release in cloud mode stands in for the companion, paired the way a box is, while its Mac moves to the compiled file and back (the bridge across versions, the companion answering while the Mac sleeps, what the Mac's companion-build flow does) |

```bash
FLEET_OLD_MAC=<old archive>/bin/walnut \
FLEET_NEW_MAC=<dir>/walnut-darwin-arm64 \
  bash scripts/run-fleet-tests.sh tests/fleet/upgrade.fleet.ts
```

`FLEET_NEW_MAC` needs `walnut-linux-<arch>` of the same build-binary run beside
it (a host takes that sibling file). The compiled file must be a build of a
commit (no uncommitted changes), or the host server refuses it. Replacing the
Mac (`replaceMac`) stops its server only: its own daemon and ssh keep running
for the next server to find, as an update leaves them.

## Faults

| Method | What it does |
|---|---|
| `sleepMac()` / `wakeMac()` | SIGSTOP / SIGCONT of the Mac server, its own daemon and its ssh processes (a lid close: the sockets stay open and go silent) |
| `pauseHost(name)` / `unpauseHost(name)` | `docker pause`: the host freezes with its sockets open |
| `cutLink(name, 'silent')` | the proxy keeps every connection open and forwards nothing (a network gone quiet); the heal closes both ends |
| `cutLink(name, 'severed')` | the same, but the heal closes only the Mac's ends: the host's sshd keeps its side open, as after a network change, and the daemon has to notice a client that never answers |
| `cutLink(name, 'drop')` | the proxy closes every connection and holds new ones silent |
| `healLink(name)` | back to forwarding (new connections go through again) |
| `slowLink(name, { delayMs, bytesPerSec })` | latency and a byte rate on the link |
| `clockOffset: { devbox: '+90s' }` (startFleet) | libfaketime for every process an SSH session starts on that host, the daemon included |

The daemon's windows are the test knobs replica-cluster.ts uses (1 s beat, 6 s
quiet, 12 s takeover) on the Mac and on every host (through the host's
`~/.ssh/environment`); `startFleet({ windows: 'real' })` keeps the production ones.

Assertions read the stores themselves: the Mac's `tasks.sqlite` (read only) and
its log, and on a host its stream files, its journal and its copy dirs through
`docker exec`.

## Safety

- Every container, network and image is named `walnut-fleet-*` and labelled
  `walnut-fleet=1`; `docker.ts` refuses any other name before `docker` runs
  (`tests/fleet/docker-names.test.ts`). No volume is made or touched.
- A run removes its containers and network when it stops; the next run sweeps
  what a crashed run left (only containers and networks whose owner process is gone).
  Images stay as the cache until `clean`.
- Ports bind on 127.0.0.1 only. The key pair is made per run; the Mac's `ssh`
  always runs with `-F <this run's config>`, so the user's `~/.ssh` is never read
  or written.
- Signals go only to processes the run started and pinned (pid, start time,
  command line), never to a pid alone. The Mac never uses port 3456 or
  `~/.open-walnut`; its env is built from nothing.

## What it found

- 2026-10-23, fixed: `src/providers/ssh-control-master.ts` allowed a control
  socket path of 100 characters, but `ssh -M` binds `<path>.<16 random chars>`
  before it renames the socket into place, so on macOS (104 bytes) a path of 87
  to 100 failed with `too long for Unix domain socket` and the host ran without a
  ControlMaster (every command its own SSH login). The fleet's Mac TMPDIR made
  `walnut-ssh-devbox-<digest>` 88 characters. `expectControlMaster` in `steps.ts`
  keeps it pinned.
- 2026-10-23, fixed: the Mac told a host about a new session in its copy 3 s after
  the start (`host-slice.ts`, `PUSH_DEBOUNCE_MS`). A session whose Mac went away
  inside those 3 s was unknown to the host, so its `walnut tools call` writes
  answered "hub unreachable" (exit 5) until the Mac was back instead of being
  journaled. A start now pushes its host's copy at once (`pushStartingSession`;
  the debounce still coalesces task churn), and row 5 of `mac-and-host.fleet.ts`
  closes the lid right as a session starts and keeps it pinned.

- 2026-10-23, fixed: the compiled walnut file has no separate daemon binaries, so a
  compiled Mac gave a host where no bun runs the daemon's source under node, and a
  host with neither (`bare-host.fleet.ts`) no daemon at all, although the Mac
  holds the very file the host's Walnut server runs. That file now goes into the
  daemon binary's slot and runs as `--start` (`src/providers/daemon-file-slot.ts`,
  `DaemonConnection.deployWalnutFile`), and one upload serves both: the slot copies
  a host server install of the same file, and a host server install takes its gz
  from the slot (`seedFromDaemon` in `src/core/host-server/manager.ts`). A host
  where bun runs keeps bun and the source; one where the file cannot be had still
  gets node and the source. `walnut --status` also had to mean the daemon's
  status, as `--start` already did (`src/binary/main.ts`): the binary start
  confirms with it.

- 2026-10-23, fixed: a host without procps (a slim image) could never take a new
  daemon: the stop the Mac runs first read the old daemon's identity with `ps`
  and failed. It reads /proc on Linux now (`buildDaemonStopCmd`), as do the
  daemon's start-time reads (no more "ps: not found" in its stderr) and the
  session liveness check. `bare-host.fleet.ts` runs its hosts without ps.
- 2026-10-23, fixed: a dead daemon's pid file naming another live process (pids
  are reused after a container restart) passed for a live daemon in four places:
  the local daemon's spawn wait, both twins at `--start` (they yielded to it and
  left no daemon), and the remote live scan and dir probe (every connect went to
  the dead port). Row B4 of `bare-host.fleet.ts` plants exactly that.
- 2026-10-24, fixed: the same files fooled three more places. The remote start's
  readiness poll took `kill -0` of the old pid for the new daemon and reported the
  dead daemon's port (it now waits for files written since the start, or for the
  start to yield to the daemon already there), the twins' `--status` said running
  (it now needs a daemon to answer on the port), and the legacy yield took any
  listener on that port for a daemon (it now needs the daemon's own answer). The
  live scan's identity check matched any command line with ` --start ` in it; it
  now needs that dir's daemon file. Row B5 runs the slot's walnut file by hand the
  way the Mac does (`nohup env ... --start`, `--status`, `--stop`) over such files.
- 2026-10-24, fixed: the twins' `--stop` signalled whatever daemon.pid named: a
  file holding -1 was kill(-1), every process of the user. It now takes only a pid
  above 1 that is this dir's daemon (the instance lock names it, or, for an older
  daemon, its command line runs this dir's daemon file).
- 2026-10-24, fixed: an update stopped the old daemon first and only then fetched
  and uploaded the new one, so the host had no daemon for the whole upload (minutes
  for the walnut file on a slow link), and none at all when the upload failed. The
  new daemon now goes onto the host while the old one runs (`stageUpgrade` in
  `src/providers/daemon-connection.ts`); a failed transfer leaves the old daemon
  serving and asks again later, and a daemon that runs as the binary is never
  traded for the source because one upload failed.
- 2026-10-24, fixed: the slot took the walnut file without running it. It now
  runs `<file> __daemon --version` before the rename and wants the version the Mac
  expects (a file this host's C library or CPU cannot run fails there, and the
  deploy goes to the source), and it needs about 2.5 times the file's size free in
  the daemon dir before it copies or sends anything.

## Not covered yet

- The cloud companion as a container (a host daemon dialling its `/bridge`, the
  Mac's copies reaching it): it needs a Linux build of this tree with its native
  modules and the pairing a companion is set up with. The in-process
  `tests/helpers/cloud-box-replica.ts` covers the companion today, and
  `companion-upgrade.fleet.ts` runs an old release as one on this machine.
