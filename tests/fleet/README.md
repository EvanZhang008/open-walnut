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
npm run test:fleet                                   # every tests/fleet/*.fleet.ts
bash scripts/run-fleet-tests.sh tests/fleet/mac-and-host.fleet.ts
bash scripts/run-fleet-tests.sh clean                # remove leftovers and the cached images
DEBUG_FLEET=1 KEEP_FLEET=1 npm run test:fleet        # Mac stderr live; keep the containers and temp dir
```

Opt-in, like the live tier: no other config includes `*.fleet.ts`, so the
fleet never runs in quick, unit, integration, e2e or CI. Without Docker each
file prints a SKIPPED line and the script exits 0 (not authoritative).

Cost: the first run pulls `node:22-bookworm-slim` (kept as
`walnut-fleet-base:node22-bookworm-slim`) and builds `walnut-fleet-host:<hash>`
(a minute or two). After that the Mac boots in about 10 s,
`mac-and-host.fleet.ts` takes about a minute and `host-faults.fleet.ts` about two
(70 s of it is the deploy through the 4 MB cap). Each host container is capped at 1 GB, 1.5 CPUs
and 512 processes. A run holds a Walnut server, its daemons and one container per
host, so run one fleet at a time, on a machine that is not already busy.

The daemon the Mac deploys: the prebuilt Linux binary when `dist/daemon-binaries`
holds one for the container's architecture (`npm run build:daemon`), otherwise the
daemon's source under the host's node. The host has no bun and no curl, so the
bun install step fails at once and is skipped, as on a host with no way out.

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
- 2026-10-23, open: the Mac tells a host about a new session in its copy 3 s after
  the start (`host-slice.ts`, `PUSH_DEBOUNCE_MS`). A session whose Mac goes away
  inside those 3 s is unknown to the host, so its `walnut tools call` writes
  answer "hub unreachable" (exit 5) until the Mac is back instead of being
  journaled. `startHostSession` waits for the copy to name the session so the
  scenarios test the journal, not this window.

## Not covered yet

- The cloud companion as a container (a host daemon dialling its `/bridge`, the
  Mac's copies reaching it): it needs a Linux build of this tree with its native
  modules and the pairing a companion is set up with. The in-process
  `tests/helpers/cloud-box-replica.ts` covers the companion today.
- A host replica server (`hosts.<key>.server`) installed over SSH.
