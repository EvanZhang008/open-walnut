# Host network

The host network lets this Mac reach a Walnut machine that has no SSH door: a home box
behind a router, a laptop, a GPU machine. The machine joins with one invite link, and
from then on the Mac talks to its daemon over an encrypted connection, directly when the
two can see each other, otherwise through a relay: the one on the user's own cloud
companion, or iroh's public relays (the user's choice, below). Only Walnut uses this
connection; nothing else on either machine is reachable through it.

A machine on the host network is a host like any other: sessions, `host_exec`, files,
secrets and the host's MCP servers all work. Hosts reached over SSH keep working as before.

## The parts

| Part | Where | What it does |
|---|---|---|
| walnut-net | `native/walnut-net` (Rust, iroh 1.4.1) | Holds the machine's key (its network id), lets in only listed members, carries each daemon connection |
| Supervisor | `src/providers/net-core.ts` (both daemon twins, capability `net-v1`) | Runs walnut-net while `<net state>/config.json` exists, restarts it, downloads it when the install has none (`net-binary.ts`), and keeps it on a config it can run (below) |
| Member list and invites | `src/core/net/net-store.ts`, `src/web/routes/net-v1.ts` (cloud companion) | Keeps the user's machines, makes and checks invites, answers the relay's access question |
| No companion | `src/core/net/net-local.ts`, `net-rows.ts`, `join-ticket.ts` (the Mac) | The Mac keeps the list (`net.joined`) and its walnut-net checks each join (capability `net-join-v1`) |
| The Mac | `src/core/net/net-mac.ts`, `src/web/routes/hosts-net.ts` | Reads the list, makes each machine a `transport: net` host, hands each daemon its config |
| The link | `src/core/hosts/net-link.ts`, `DaemonConnection.dialNetHost` | Asks the Mac's walnut-net for a loopback port that reaches the machine's daemon |
| Relay | `scripts/cloud/net-relay.sh` | iroh-relay behind Caddy (`/relay`, `/ping`), and address discovery on UDP 7842 |
| Join | `src/core/net/net-join-script.ts`, `scripts/join.sh`, `src/commands/net.ts` | The script an invite link serves (and the same script with a ticket, attached to every release), and `walnut net join` |

## Joining a machine

1. Settings > Remote Hosts > Machines that joined with a link > Add a machine. The Mac
   turns the network on (`net.enabled`), tells the companion its own network id, and
   asks it for an invite: a 12 character code, one use, 10 minutes.
2. On the new machine the user runs `curl -fsSL https://<companion>/join/<code> | sh`.
   The script installs Walnut when it is missing, then runs `walnut net join`, which
   keeps the daemon running (`walnut daemon install`), has the daemon make the machine's
   key (it never leaves the machine), trades the code for a place on the list, and
   hands the daemon its config: the relay, the relay's address discovery pin, and the
   Macs it lets in.
3. The Mac sees the invite used (it watches it every 3 seconds) and reads the list again:
   the machine becomes a host row in `config.yaml` (`transport: net`, `endpoint: <id>`),
   and the Mac's own walnut-net may now dial it.

When the newest release cannot join yet (a feature reaches the release a day or two after
the preview build), the script installs the preview build (`walnut update --channel
nightly`), so a new machine never stops at step 1. It only ever uses the Walnut file
install.sh puts down (`~/.local/share/open-walnut/bin/walnut`), never another Walnut on PATH
(an npm install, an older server's), which it neither runs nor updates. Step 2 installs the
login service with that file as its daemon (`walnut --service`). The fresh-machine check runs
the real command in Terminal on a macOS runner, on a new account and on one where an older
Walnut already runs (`.github/workflows/fresh-mac-join.yml`), against a throwaway Walnut in
the same job (`tests/e2e/host-network-outside-join.e2e.test.ts`).

A machine whose older Walnut has run for days may have lost its session daemon's pid, port and
registry files to the temp cleanup (macOS removes files in /tmp nobody touched for 3 days)
while that daemon still runs and holds its instance lock, which a login service daemon beside
it would fail on. Step 2 then finds it through that lock, writes its pid, port and instance
files back (`recoverLostDaemon` in `src/commands/net.ts`, never over a file that is there),
and hands it over to the login service like any running daemon; the CI job's
`existing-swept` Mac rehearses it. Daemons from this version on keep their own files fresh
(`keepRuntimeFiles` in `src/providers/daemon-core.ts`).

## Choosing the relay

Settings > Remote Hosts, under the machines: "When two machines cannot connect directly,
they go through" one of three (`net.relay` in `config.yaml`, `PUT /api/hosts/net/relay`):

| Choice | walnut-net | What it shares |
|---|---|---|
| Your relay (`own`) | the companion's relay, `relayMode` absent (the config it always had) | nothing beyond the user's own machines |
| Public relays (`public`) | iroh's n0 preset: n0's relays and address lookup, publishing only the relay URL | n0's relays pass on traffic they cannot read, and see the machines' internet addresses and which talk to each other; n0's lookup lists which relay each machine uses |
| No relay (`none`) | no relay, no lookup | nothing; machines behind two home routers may not connect |

A paired companion always means Your relay: a machine that joins through it comes up on its
relay, so with any other choice each new one would be unreachable (the other two rows say
what they share but cannot be picked). Without one, public relays unless the user picks No
relay, so a machine behind a home router still connects. A change goes to every machine
first, while the Mac still reaches it the old way, then to the Mac; a machine that is away
keeps the old way until the Mac reaches it again, and the Mac still finds it there:

- The Mac keeps where it last reached each machine (`net.where`: its addresses, the address
  the Mac reached it at first, and the relay it was on when that is one of the Mac's own,
  the companion's) and dials it there too; with No relay only the addresses. The relay
  kept stays while the machine is still on it (one that could not move yet, also after
  unpairing) and goes only when it reports another one. A relay a
  machine names is never taken from it, so a machine cannot send the Mac anywhere, and
  with Your relay no relay but a companion's is contacted (a machine still on an earlier
  companion's relay is dialled there until it moves). That is an address book, never the list: it
  decides no machine's membership, and an entry a Remove dropped is never written back.
- Pairing a companion voids an earlier pick (`net.relay` is cleared), so unpairing later
  goes back to public relays, never to an old No relay that would cut off the machines that
  joined through the companion. A machine on public relays that is away when a companion is
  paired, behind a router, is not found on the companion's relay: it needs a new invite.
- No relay is refused while a machine the Mac reaches now would be cut off: one linked
  through a relay, or directly at an address the machine does not have (a router in
  between, crossed with the relay's help). Told to drop its relay, it could never be told
  otherwise. A machine that is away is not told, so it is safe.
- Every walnut-net listens on the UDP port it had last time (`<key>.port` beside its key; a
  port another program took gets a new one), so with no relay a machine that restarts is
  found at the same address. A machine whose address changes while the Mac cannot reach it
  needs a new invite.
- An older daemon (no `net-join-v1`) or walnut-net (control protocol 1) would drop the relay
  mode and run with no relay at all: it is never handed public or none. It keeps the
  config it has until it is updated, and the Mac's own sync says why. The machines are told
  only once the Mac's own walnut-net reports relay modes, so the Mac can always follow them.
  A host that starts walnut-net with a relay mode downloads this version first.

## Without a companion

A Mac with no companion keeps the list itself: `net.joined` in its `config.yaml`, plus
its `transport: net` host rows. Add a machine makes the invite on the Mac: walnut-net gets
a hash of the code (`net.invites`) and, while an invite is open, answers a new machine on
the ALPN `walnut/join/1` (one line: the code, the host name, the platform, where it listens;
checked in constant time, one use, 10 minutes, 5 failures per caller and 30 overall per 10
minutes).
The command Settings shows is

    curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/join.sh | sh -s -- wn1-...

where `wn1-...` is the ticket: the Mac's id, the code, the relay choice, and the Mac's
addresses and relay. `walnut net join <ticket>` has the machine's daemon let the Mac in
(`net.join` with `relayMode`), then ask the Mac, over the host network, to take it in; when
the Mac refuses (a used or old link, too many tries) or does not answer, the machine goes
back to the network it had (none: off), so pasting the command twice never cuts off a
machine that joined. A machine that had no network and gets no answer keeps the Mac's
config, so one whose Mac took it in but lost the answer is still reached, and the same
command can run again. The Mac must be awake and online while the machine joins.

The Mac keeps the machine before walnut-net forgets the invite, so a write that fails tries
again. walnut-net keeps invites in memory: one it lost (it restarted) ends and is never handed
over again, since it may have been used just before. A server that starts takes any join an
earlier run never read, and has walnut-net forget the invites that run made. At most 16 links
are open at once. Pairing a companion later moves the list to it (the Mac puts every
machine it has on the companion's list).

## What keeps strangers out

- Every daemon's walnut-net closes a connection before any stream unless the peer's id
  (its key, proven by the TLS handshake) is a member with `accept: true`. A joined
  machine lets in only the Macs; the Mac lets in nobody. The one exception is the join
  ALPN on a Mac with no companion: open only while an invite is, it reads one line and
  answers whether the code was right; no stream reaches the daemon.
- The relay lets in only members: for each connection it asks the companion
  (`POST /api/v1/net/relay-access`, loopback only, with a token from `/etc/walnut`).
- An invite is checked by hash in constant time, a wrong one counts toward the caller's
  auth rate limit, and only the Mac that owns the companion may make one, list the
  machines or remove one.
- Address discovery on UDP 7842 tells a caller its own public address and nothing else:
  it relays nothing and accepts no stream. It has its own certificate, made on the
  companion; machines trust that certificate alone (the pin rides their config).

## A config walnut-net cannot run

The supervisor knows which config the running walnut-net took. A new one goes in by a
reload, one at a time; a change of relay or key restarts walnut-net (exit 75), and the
configure answers once the new process is up.

- A reload walnut-net refuses leaves the config it runs in place, on disk too, and the
  configure says why.
- A config it cannot read at start (exit 78) is replaced by the last one it came up on or
  took in a reload (`config.last-good.json`), and the configure says so. A start that
  fails for another reason (an unreadable key, a port) keeps the new config and retries.
- A member whose id is not a key, or whose address is bad, is left out of the list with a
  warning in its log; the other members stay.
- A daemon that moved to a new walnut-net version runs the newest older download while it
  downloads the new one, then moves to it. It keeps that version and one older one.

## When the companion is down or loses its list

The relay and the member list live on the companion. While it is down, no machine joins,
a link already up directly stays up, and a new link waits for the relay. A companion that
comes back without its list (a rebuilt box) gets every machine back from the Mac, which
keeps each one as a host row; a list file it cannot read is an error, never an empty list,
so the Mac never takes that for every machine removed. An entry in the list that this
version does not know (a newer version wrote it) is kept as it is by every write.

## Removing a machine

Settings > the machine > Remove. The Mac notes the removal in `net.removing` (a restart
halfway finishes it), the companion drops the machine from the list (so the relay refuses
it), the Mac tells the machine to stop its walnut-net (it keeps its key), and drops its
host row. No sync hands the machine its list again while it is being removed. When the
companion cannot be reached, nothing changes and Remove says why. A machine that is away
when it is removed is not told, but it can no longer reach anything.

## Limits

- A joined machine learns the Mac's id and the relay from the Mac, over the link itself.
  A new Mac (a new key) or a companion at a new address cannot reach the machines that
  joined before: run a new invite on each.
- An older Walnut reads a machine's row as an SSH host whose name never resolves (it fails
  at once). Its Remote Hosts editor may save the row without `transport` and `endpoint`;
  this version takes such a row back by its hostname and the machine's name (the row's
  label, else its name).

## Where things live

| What | Path |
|---|---|
| A machine's key, config and log | `~/.local/state/open-walnut/net/` for the user's own daemon (the login service or not; never moved by `XDG_STATE_HOME`, so one machine has one key), else `<daemon dir>/net` |
| The downloaded walnut-net | `<net state>/bin/walnut-net-<version>` (this version and one older) |
| The member list | the companion's `${XDG_STATE_HOME}/open-walnut/net-members.json` (outside its synced data) |
| The Mac's settings | `net.enabled`, `net.relay`, and with no companion `net.joined`, in `config.yaml` |

## Releases

walnut-net is published as the prerelease `walnut-net-v<version>` by
`.github/workflows/walnut-net.yml` (run by hand; a published version is never changed).
A daemon whose install has no walnut-net downloads its platform's file from there and
checks it against `NET_BIN_SHA256` in `src/providers/net-binary.ts`, else that release's
`SHA256SUMS`. `WALNUT_BUILD_NET=1 bash scripts/build-daemon.sh` builds it locally with cargo.

## Setting up the companion

`scripts/cloud/setup.sh` runs `scripts/cloud/net-relay.sh`: the official iroh-relay 1.4.1
build (pinned SHA-256), the relay and address discovery units (a throwaway user, no
capabilities, nothing writable), and the env Walnut needs to hand machines their config.
The AWS stack (`infra/lib/walnut-cloud-stack.ts`) opens UDP 7842. On a companion whose
firewall does not, machines still connect, through the relay on 443.

## Knobs

| Env | Meaning |
|---|---|
| `WALNUT_NET_BIN` | Use this walnut-net |
| `WALNUT_NET_NO_DOWNLOAD=1` | Never download it |
| `WALNUT_NET_RELEASE_BASE_URL` | Where releases are downloaded from |
| `WALNUT_NET_ALLOW_HTTP_RELAY=1` | Let walnut-net use a plain-HTTP relay (tests) |
| `WALNUT_NET_ALLOW_HTTP_JOIN=1` | Let `walnut net join` talk to a plain-HTTP companion (tests) |
| `WALNUT_JOIN_DAEMON_DIR` | `walnut net join` uses the daemon in this dir and installs no service (tests) |
| `WALNUT_NET_ACTIVE=1` / `0` | Run the network on a test or throwaway server (off there by default: its copied config would put a test key in the Mac's place), or never |
| `WALNUT_NET_RELAYS`, `WALNUT_NET_RELAY_TOKEN_FILE`, `WALNUT_NET_RELAY_ROOT_FILE` | The companion's relay settings (written by `net-relay.sh`) |
