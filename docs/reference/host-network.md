# Host network

The host network lets this Mac reach a Walnut machine that has no SSH door: a home box
behind a router, a laptop, a GPU machine. The machine joins with one invite link, and
from then on the Mac talks to its daemon over an encrypted connection, directly when the
two can see each other, otherwise through the relay on the user's own cloud companion.
Only Walnut uses this connection; nothing else on either machine is reachable through it.

A machine on the host network is a host like any other: sessions, `host_exec`, files,
secrets and the host's MCP servers all work. Hosts reached over SSH keep working as before.

## The parts

| Part | Where | What it does |
|---|---|---|
| walnut-net | `native/walnut-net` (Rust, iroh 1.4.1) | Holds the machine's key (its network id), lets in only listed members, carries each daemon connection |
| Supervisor | `src/providers/net-core.ts` (both daemon twins, capability `net-v1`) | Runs walnut-net while `<net state>/config.json` exists, restarts it, downloads it when the install has none (`net-binary.ts`) |
| Member list and invites | `src/core/net/net-store.ts`, `src/web/routes/net-v1.ts` (cloud companion) | Keeps the user's machines, makes and checks invites, answers the relay's access question |
| The Mac | `src/core/net/net-mac.ts`, `src/web/routes/hosts-net.ts` | Reads the list, makes each machine a `transport: net` host, hands each daemon its config |
| The link | `src/core/hosts/net-link.ts`, `DaemonConnection.dialNetHost` | Asks the Mac's walnut-net for a loopback port that reaches the machine's daemon |
| Relay | `scripts/cloud/net-relay.sh` | iroh-relay behind Caddy (`/relay`, `/ping`), and address discovery on UDP 7842 |
| Join | `src/core/net/net-join-script.ts`, `src/commands/net.ts` | The script an invite link serves, and `walnut net join` |

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

## What keeps strangers out

- Every daemon's walnut-net closes a connection before any stream unless the peer's id
  (its key, proven by the TLS handshake) is a member with `accept: true`. A joined
  machine lets in only the Macs; the Mac lets in nobody.
- The relay lets in only members: for each connection it asks the companion
  (`POST /api/v1/net/relay-access`, loopback only, with a token from `/etc/walnut`).
- An invite is checked by hash in constant time, a wrong one counts toward the caller's
  auth rate limit, and only the Mac that owns the companion may make one, list the
  machines or remove one.
- Address discovery on UDP 7842 tells a caller its own public address and nothing else:
  it relays nothing and accepts no stream. It has its own certificate, made on the
  companion; machines trust that certificate alone (the pin rides their config).

## When the companion is down or loses its list

The relay and the member list live on the companion. While it is down, no machine joins,
a link already up directly stays up, and a new link waits for the relay. A companion that
comes back without its list (a rebuilt box) gets every machine back from the Mac, which
keeps each one as a host row; a list file it cannot read is an error, never an empty list,
so the Mac never takes that for every machine removed.

## Removing a machine

Settings > the machine > Remove. The Mac tells the machine to stop its walnut-net (the
machine keeps its key), the companion drops it from the list (so the relay refuses it),
and the Mac drops its host row. A machine that is away when it is removed is not told,
but it can no longer reach anything.

## Where things live

| What | Path |
|---|---|
| A machine's key, config and log | `${XDG_STATE_HOME:-~/.local/state}/open-walnut/net/` for the user's own daemon, `<service state>/net` for the login service, else `<daemon dir>/net` |
| The downloaded walnut-net | `<net state>/bin/walnut-net-<version>` |
| The member list | the companion's `${XDG_STATE_HOME}/open-walnut/net-members.json` (outside its synced data) |
| The Mac's setting | `net.enabled` in `config.yaml` |

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
| `WALNUT_NET_ACTIVE=1` / `0` | Run the network on a test or throwaway server (off there by default: its copied config would put a test key in the Mac's place), or never |
| `WALNUT_NET_RELAYS`, `WALNUT_NET_RELAY_TOKEN_FILE`, `WALNUT_NET_RELAY_ROOT_FILE` | The companion's relay settings (written by `net-relay.sh`) |
