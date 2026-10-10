# One Walnut server, on any machine, reachable from anywhere

Status: stages 1 and 2 built; the other stages below ship in order. Builds on
[the control plane](./walnut-control-plane.md) (who leads, the companion's copy,
the one request path) and [daemon-first hosts](./daemon-first-hosts.md).

## Summary

There is one Walnut server program. It runs on the Mac, on the cloud companion,
and on any host the user picks (a cloud desktop, say). Each copy plays one role:

| Role | Where it runs today | What it does |
|---|---|---|
| **leader** | the Mac | owns the data, runs everything |
| **follower** | the cloud companion; a server on a host (new) | sends what the leader owns to the leader while it answers, answers from its own copy while it does not |
| **alone** | a follower that cannot reach any leader | answers from its copy and its local daemon, keeps its own writes for the leader |

A follower always has a local daemon when it runs on a host, so "alone" still
means working sessions on that host. Followers find the leader through the
daemon they already talk to: the leader connects to every daemon, and every
daemon keeps the leader book (`src/providers/leader-core.ts`: which Walnut, who
leads, the epoch). A server never searches the network for a leader.

Any server can also be **exposed**: put behind a tunnel or a reverse proxy so a
browser anywhere (a phone, another computer) can open it. How the tunnel is made
is a **provider**: a short definition (a command to run, the pattern of the URL it
prints, the lines that mean "sign in again"). Walnut ships a generic one and
runs it; a provider for a company's own tunnel service lives in a private plugin
and contributes only its definition.

## Routing: one rule, three kinds of route

Every request a follower gets falls into one of three kinds:

1. **Leader first.** Anything the leader owns (tasks, the Personal AI, launches,
   messages across hosts). While the leader answers, the follower carries the
   request to it and passes the answer back as it is. While it does not, the
   follower answers from its copy, or says plainly that this needs the leader.
   This is the companion's one request path (control plane doc), now a property
   of every follower.
2. **Local always.** What belongs to the machine the follower runs on: its own
   sessions' streams, its files, its health. Answered locally, leader or not.
3. **Feature with fallbacks.** A capability with an ordered list of engines.
   Speech to text is the model case: the leader's engine (the Mac has the good
   local model), then this server's own engine if it has one, then a hosted API
   if a key is configured, then a plain sentence saying why voice is off.
   `routeFeature` (`src/core/feature-route.ts`) tries such a list in order:
   an engine not set up here is skipped, a failure hands the input on, and a
   verdict about the input itself (an undecodable recording) ends the list.

How a follower reaches the leader depends on the path it has:

| Path | Who has it | What crosses |
|---|---|---|
| **byte path** | a server on a host: a stream its daemon passes from its link to the Mac's (see "One kind of link") | every HTTP request and WebSocket, unchanged, no size cap |
| **bridge forward** | the companion: the Mac's daemon dials its `/bridge` | `/api/v1` calls as `server.http`, 1 MB in, 256 KB out |

The decision "does the leader answer now" is one function per follower, fed by
the leader's heartbeat and the last forward's outcome (`macAnswers` in
`src/web/v1-forward/proxy.ts`). Every route asks it; none keeps its own view.

## Exposure

### What runs

```
browser ── tunnel provider (a process this server runs) ── 127.0.0.1:<tunnel port> ── this server
```

- The server listens on a second loopback port, the **tunnel port**, only for
  tunnels and reverse proxies. Nothing that arrives there is ever treated as
  this machine: a tunnel connects from loopback, so loopback proves nothing
  (`src/web/middleware/local-trust.ts`). Every request on it needs a device token,
  WebSockets included. The main port keeps its rules.
- The server runs the provider's command with the tunnel port filled in, reads
  its output for the public URL (and, for a CLI that prints its address before
  the connection is up, a ready line), and keeps it running: restart with
  backoff after an exit, `needs sign-in` when a line says the sign-in expired (no
  tight loop of retries), `missing` when the command is not installed, a restart
  when the address stops answering, stop on shutdown. One provider at a time per
  server (`src/core/expose/supervisor.ts`, `src/web/expose-runtime.ts`).
- State is shown in Settings (Phones & Cloud, Open from a browser): the provider,
  its options, the switch, its state in one sentence with Retry when it waits,
  the URL, and the code that signs a browser in.
- Only the person at this machine turns it on or changes it (`/api/expose`, and
  the `expose` section of a config write): a session or a signed-in device gets
  `403`, because the command runs here and the switch puts this server one
  address away from the internet.

### Providers

| Provider | Where it lives | Notes |
|---|---|---|
| `command` | built in | any tunnel CLI: the user writes the command, its arguments (`{port}` is the tunnel port), the URL pattern and optionally a ready pattern in config.yaml (`expose.command`). For example `cloudflared tunnel --url http://127.0.0.1:{port}`. |
| a company tunnel service | a private plugin | registers one definition through `walnut.expose.register(...)` (docs/reference/plugin-development.md, "Tunnel providers"): command, arguments, options the person sets (a tunnel name), URL and ready patterns, sign-in patterns, the hints to show (how to install it, how to sign in again). No code of its own runs in the tunnel's lifecycle. |

A definition is data, not code, so a host server can run a provider whose plugin
is installed only on the Mac: in stage 2 the Mac sends the definition along with
the host's settings.

### Signing in a browser

A browser that is not this machine needs a device token. The console mints a
**browser sign-in code** (`POST /api/devices/browser-code`, this machine only):
eight characters, one use, ten minutes. The browser that opens the exposed URL
sees the existing "not paired" notice, now with a field for the code (or a link
carrying it after `#pair=`, so the code never reaches a server log). The code is
exchanged once (`POST /api/v1/browser-pair`, public on a primary, rate limited)
for an ordinary device token named `browser-<6 hex>`, which the device list shows
and can revoke. Wrong codes have their own count, apart from token failures:
through a tunnel every caller is the same loopback address, and a browser still
holding a removed token spends the token count on its first page load. In stage
2 the token is copied to the server's followers the way phone tokens are today
(device adoption), so the same browser keeps working while the leader is away.

## A server on a host

A host the user picks can run a follower: the **host server**. It is what makes a
cloud desktop a front door that is up while the Mac sleeps.

```
phone ── tunnel (on the host) ── host server ── stream via the host's daemon ──(Mac awake)── Mac's tunnel port
                                     │                                  └──(Mac away)── the companion
                                     └──(neither)── its own copy + the host's daemon
```

- **Lifecycle.** The host's daemon keeps the host server running (start, restart
  after a crash, survive the Mac sleeping); the Mac installs and upgrades it on
  connect, the way it deploys the daemon. It listens on one loopback port, the
  one its tunnel points at.
- **Leader path.** While the daemon says the Mac leads and hears it, every
  request and WebSocket goes to the Mac byte for byte, on a stream through the
  daemon that lands on the Mac's tunnel port. The phone sees the Mac's full
  console. A stream that cannot be opened (the Mac's link just went) sends that
  request, if it is a read, on to the companion at once.
- **Leader away.** Requests go to the companion, on a stream through the same
  daemon, while the companion is linked to the host. With neither, the host
  server answers alone: today a page and a JSON error that say why. Stage 4
  makes that answer its own copy, fed by the host's daemon (which already keeps
  the copy its sessions need: task slice, notes, memory, skills); writes go to
  that daemon's journal, which the Mac drains when it returns.
- **Copies.** The Mac pushes the same copies it pushes to the companion (the task
  store, the search index) to every follower, the host server included: to the
  host server on a stream through its daemon (`src/core/replication/replica-targets.ts`
  names the targets; `src/core/server-role.ts` says which role this server plays
  and whether its leader answers).
- **Runtime.** The host needs a Node that runs there. On an older Linux (glibc
  2.26), stock Node 24 does not start and the prebuilt SQLite module does not
  load; a Node built for that system and a newer compiler for native modules
  (`CC`, `CXX`) are the answer, and the install step checks both before it starts
  anything.

### One kind of link

Every connection is the same thing: a two way link between **a server and a
daemon**. How it was dialled is a detail of the transport underneath; once up,
either side sends requests and events on it.

```
  Mac server ──┐               ┌── companion server
  (SSH, dials) │               │  (the daemon dials its /bridge)
               ▼               ▼
          daemon (one per host) ◄── loopback ── host server
```

- Daemons never link to each other, and servers never link to each other.
  (The Mac's HTTPS push to the companion is the one exception today.)
- One server reaches another through a daemon both are linked to. The
  companion already reaches the Mac this way (`server.http` through the Mac's
  daemon). A host server links to its own host's daemon only, and reaches the
  Mac and the companion through it.
- The daemon's one primitive for this is a **byte stream** between two of its
  links (`src/providers/stream-relay-core.ts`, both twins, capability
  `stream-relay-v1`): `stream.open {sid, to}`, then accept, data, ack, end and
  close frames in either direction. The server that receives a stream treats it
  as an ordinary connection to its own door (`src/lib/link-stream.ts`). The
  daemon holds no bytes: each end acks what it read and keeps at most a window
  unacked, so a slow end slows its peer and never fills the daemon. Bytes are
  base64 in JSON frames: simpler than a binary framing, and a third more bytes.
- Who may open to whom: the host server to the primary of its own Walnut or to
  the companion; the primary to the host server of its Walnut; the bridge opens
  nothing and only answers. A stream ends when either link drops.

So the daemon on a host has up to three clients, and tells them apart, because
most of what it does assumes a trusted client is the leader:

| Client | How it connects | What the daemon lets it do |
|---|---|---|
| the Mac's server | the SSH forward (a trusted socket, tagged with its data dir by `leader.configure` / `host.slice`) | everything: it configures the host (hooks, triggers, the host copy, the bridge), drains the journal, stops sessions, says which server the daemon keeps running here, opens streams to it |
| the cloud companion | the bridge (the daemon dials out; one slot) | the narrow bridge set; it leads only by the leader book's rules; it answers streams a host server opens |
| the host server | loopback, then `follower.hello {walnutId, home, token}` | reads (`follower.status`, the session list, a session's stream), its report, streams to the Mac or the companion; never a configure command |

A follower socket is never mistaken for the leader:

- its frames are not "the primary was heard" (otherwise a host server that is
  always up would keep the companion from ever leading while the Mac sleeps);
- it is never the target of a session's `walnut` call, a relayed message, a
  trigger event or a cron note, all of which only the leader acts on;
- a command that writes state the leader owns (`leader.*`, `host.slice`,
  `replica.*`, `hooks.configure`, `triggers.configure`, `bridge.configure`,
  `server.configure`, `offline.drain`, a stop) is refused with `follower_refused`;
- `follower.hello` takes only the token the daemon started that server with, so
  no stray process on the host takes its place.

The bridge slot stays the companion's. Who leads right now comes from the leader
book through `follower.status` (holder, epoch, whether the primary was heard),
so the host server keeps no view of its own and probes nothing.

The daemon keeps the host server running (`server.configure {spec}` from the
leader only, `server.status`; `src/providers/host-server-core.ts`, both twins,
capability `host-server-v1`): it starts it in its own process group with a token
of its own, restarts it with backoff after an exit, adopts it after a daemon
restart (pid and start time must match), passes it the spec's `settings` (its
tunnel) without a restart, keeps its last `follower.report` for the leader, and
stops it when the spec is removed. One spec per Walnut data dir, so a test
server never touches the real one.

### The stream lane

The Mac's link to a host rides one SSH connection that every session on the
host shares (the ControlMaster). A stream can be megabytes (a copy of the
search index, the web app a browser loads through the host server), and on a
network that corrupts packets one bad MAC ends the SSH connection it rode, with
every session's stream on it. So while a host server runs, the Mac keeps a
second link to that daemon, the **lane** (`src/providers/stream-lane.ts`,
capability `stream-lane-v1`), and the streams ride it:

- It is its own SSH connection (`ControlMaster=no`, `ControlPath=none`, ahead of
  anything a config file says), so a lane that dies takes nothing else with it.
  Its remote command reads stdin, so it ends with the server that holds it,
  also one that crashed.
- A lane that was up dials again at once (a bulk stream on that network ends
  its connection every 15 MB or so, measured); a dial that fails waits longer
  each time (5 s to 5 min). A stream waits for a lane that is coming back
  rather than take the session link: the Mac's for up to 10 s, a host
  server's for up to 3 s in the daemon (its lane closed less than 30 s ago).
- On it, the Mac sends `stream.lane {home, walnutId}` (the Walnut its
  `leader.configure` described). The daemon then lets that socket send only
  hello, ping and stream frames (`lane_refused` otherwise), sends it no
  broadcast, never takes it for the primary, lets it open streams to its
  follower only, and offers a follower's stream to the primary to the lane
  first while it answers its beats.
- It is optional. With an old daemon, or a login that needs a fresh sign-in
  (an expired certificate: the master still serves, a new connection does
  not), streams ride the session link as before. A stream that was on a lane
  when it dropped ends with it: the request it carried fails (a copy round is
  tried again on its next round, a browser shows the error).

## What stays out of the open source tree

Only the provider definition of a company's tunnel service is private: its
command name, its URL shape, the wording of its sign-in error, how to install it.
That definition lives in the user's private plugin store. Everything that runs
it (the tunnel port, the supervisor, the sign-in code, the host server, the
routing) is generic and lives here.

## Security

- The tunnel port never grants local trust, whatever headers arrive.
- The sign-in code is single use, short lived, and its exchange is rate limited;
  a wrong code costs the caller a strike. The exchange is public on a primary
  only: a replica asks for its own device token first, so its `/api/v1` forward
  is no door from the internet to the primary's codes.
- A tunnel provider's own access control (a company sign-in, a tailnet) stays in
  front; the device token is the second lock, never the only one we recommend.
- A host server's stream lands on the Mac's tunnel port (token required), never
  on its main port (which trusts loopback); every forwarded request carries
  X-Forwarded-For, so no server takes it for its own machine.

## Stages

| # | Stage | State |
|---|---|---|
| 1 | Exposure: tunnel port, supervisor, `command` provider, plugin API, sign-in code, Settings | built |
| 2 | Host server, leader awake: install and run on a host, streams through its daemon, byte forward | built |
| 3 | Feature routing: one helper (`src/core/feature-route.ts`), speech to text on every server | built for speech to text |
| 4 | Host server, leader away: copy fed by the host's daemon, journaled writes | after 2 |

## Not yet

- More than one follower that may lead (only the companion takes the lead).
- A host server reaching hosts other than its own while the Mac is away.
- Tailscale Serve as a built-in provider (its lifecycle is a setting, not a process).
