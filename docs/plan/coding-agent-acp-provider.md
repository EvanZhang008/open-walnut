# Coding Agents Through ACP

> Status: architecture decision and implementation plan.
> Scope: add a Codex backend through ACP with an in-process worker, while keeping
> native Claude sessions unchanged. A Claude ACP backend is deferred.

## Architecture

### Target topology

```text
Browser
  |
  | Walnut session RPC and events
  v
Walnut web server
  |
  | DaemonConnection (local WebSocket or SSH tunnel)
  v
walnut-daemon
  |
  | ordinary child process, NDJSON JSON-RPC over the worker's stdio
  v
ACP host worker (one per Walnut session, dies with the daemon)
  |
  | @agentclientprotocol/sdk over NDJSON stdio
  v
provider ACP adapter
  |-- codex-acp -> Codex app-server and Codex thread
  `-- (deferred) claude-agent-acp -> Claude Agent SDK
```

The ACP host worker is a **separate process but an ordinary daemon child** (the
in-process model, matching how reference ACP clients run their adapters). It owns
the ACP client connection, the adapter child, pending JSON-RPC requests, and the
append-only event journal. It is a separate process — rather than ACP-in-daemon —
for three reasons: the ACP SDK stack ships once in one worker artifact instead of
being duplicated into both daemon twins (`daemon-standalone.ts` + `daemon-source.ts`);
a worker crash cannot take the daemon down; and the daemon↔worker RPC seam is
transport-swappable (stdio today, Unix socket if the deferred detach upgrade ever
lands).

**Deliberate consequence:** the worker dies with the daemon. Daemon replacement or
crash kills in-flight ACP turns. Completed history always survives (journal on disk
+ provider-side thread); the session recovers lazily via ACP `session/load` on the
next message. This was an explicit product decision (2026-07-18): the detached
model's only additional guarantee — a turn surviving daemon replacement — does not
justify its socket/registry/adopt/handshake machinery, because the crash-recovery
cold path is required in BOTH models anyway.

### Session identity

```text
runtimeId                  providerSessionId
---------                  -----------------
Walnut supervisor identity ACP session ID
immutable                  provider-specific resumable session
keys journal and registry  keys provider history and resume
known before process start learned from session/new
```

Keep these identities separate. A temporary supervisor ID must not be renamed
when the provider returns its session ID.

For compatibility, the existing `claudeSessionId` storage/API field carries the
provider session ID during the first release. Treat `claudeSessionId` as a legacy
name rather than attempting a repository-wide API rename in this project.

### Lifecycle ownership

```text
Component             Dies with web server  Dies with daemon  Per session
--------------------  --------------------  ----------------  -----------
Walnut UI state       yes                   no                yes
Daemon subscription   no                    yes               yes
ACP host worker       no                    yes               yes
ACP adapter           no                    yes               yes
Provider runtime      no                    yes               yes
Journal on disk       no                    no                yes
Provider history      no                    no                yes
```

Cleanup is automatic by construction: daemon death closes the worker's stdio →
worker exits → adapter detects stdin close and terminates its provider runtime
(codex-acp kills its app-server ~2s after ACP stdin closes). No reaper race, no
orphan protocol — plus a belt-and-suspenders startup sweep (below).

### Daemon crash and restart recovery

This is the core lifecycle contract (pattern verified against a production ACP
client that recovers the same way):

1. **Persist early.** `providerSessionId` is persisted to the session record as
   soon as `session/new` returns. Worker registry entries (runtimeId, worker pid,
   start-time, in-flight flag) are persisted by the daemon.
2. **Startup sweep.** On daemon start, any registry entry whose pid+start-time no
   longer matches a live process is dead by definition (workers die with the
   daemon). Kill any stragglers by process group.
3. **Startup repair.** For each dead entry that was flagged in-flight: append
   `{kind:'meta', event:'turn-interrupted', reason:'daemon-restart'}` to the
   session's journal, and `{kind:'meta', event:'permission-auto-cancelled'}` for
   any pending permission — so the UI never shows a stuck spinner or a dead
   approval button. Never claim an interrupted turn completed.
4. **Lazy resume.** No worker is respawned at startup. The NEXT message to the
   session spawns a fresh worker → `initialize` → `session/load(providerSessionId)`
   (with retries) → prompt. If load fails, fall back to `session/new` with a
   visible warning. Idle-culled sessions resume through the identical path.
5. **Replay is journal-authoritative.** During `session/load`, adapter-replayed
   history notifications are suppressed, never forwarded — the journal (and the
   web server's DB-backed history) is the single replay source, which prevents
   duplication.

### Idle policy

The idle timer lives in the **daemon** (same policy home as the native
`SESSION_IDLE_KILL_MS` path). Graceful shutdown = append a journal meta fact →
send the worker a `shutdown` op → stdio chain tears down the adapter and provider
runtime. The cold-resume contract after idle cull is identical to the crash path.
(In the deferred detached model this timer would move into the worker; that is
noted only in the deferred appendix.)

### Event path

```text
ACP update
  -> worker appends {kind:'acp', frame} raw to <runtimeId>.acp.jsonl
  -> daemon tails the journal and pushes lines to subscribers (existing
     replay-from-offset + live push machinery, byte offset = cursor)
  -> Walnut server normalizes on read: pure frame -> event translation
  -> frontend receives the existing session event contract
```

Journal grammar: `{kind:'acp', frame}` for raw inbound ACP frames,
`{kind:'meta', event}` for worker/daemon-observed lifecycle facts
(turn-interrupted, permission-auto-cancelled, command-accepted). One atomic
`write()` per newline-delimited record; readers never advance past the last
complete newline, so a mid-write crash cannot corrupt the cursor. Raw frames in
the journal + normalize-on-read means a mapping bug is hot-fixable in the server
without touching journals — the same property that lets the native path survive
parser bugs.

The normalizer is a pure `frame -> displayDTO` function with no handle to the
RPC/dispatch path, so replay is side-effect-free by construction: a replayed
`session/request_permission` renders as resolved (its closing meta fact says so)
and can never re-open a phantom approval dialog.

### Control plane and idempotency

Worker ops: `initialize`, `newSession`, `loadSession`, `prompt`, `cancel`,
`permissionResponse`, `getState`, `shutdown` — NDJSON JSON-RPC over the worker's
stdio. Every mutating op carries a caller-generated `commandId`; the worker
dedups (in-memory) and returns the original result on retry; acceptance is
journaled as a meta fact. This protects the web-server↔daemon hop against
retry-after-lost-ack duplicating a turn. (In-memory-only dedup is sufficient:
worker death is always the cold path, so there is nothing meaningful to protect
post-crash.)

Version skew between daemon and worker is impossible by construction — the worker
artifact ships inside the daemon deploy and they restart together. No attach
handshake is needed in the in-process model.

## Decision

1. Use the existing `@agentclientprotocol/codex-acp` adapter (pinned), driven via
   `@agentclientprotocol/sdk` (pinned). Do not build another provider-to-ACP
   translator inside Walnut.
2. Run one **in-process ACP host worker per Walnut session** — an ordinary daemon
   child. The detached-worker upgrade is deferred indefinitely (appendix).
3. Daemon crash/restart recovery = startup repair + lazy `session/load` cold
   resume. In-flight turns are honestly marked interrupted, never silently lost.
4. Fix both provider and backend when creating a Walnut session. Switching
   provider or backend creates a sibling session on the same task and working
   directory; it does not transplant or merge provider history.
5. Discover models, modes, and config options from ACP capabilities. Do not
   maintain a hard-coded provider model catalog.
6. Native Claude keeps its current daemon/FIFO implementation unchanged. A
   Claude ACP backend (`claude-agent-acp`) is deferred; if built, it ships as
   opt-in plus a CI-exercised conformance fixture, with no scheduled default
   flip (a future default change is a new decision on then-current evidence).

### Revision note (2026-07-18)

An earlier revision of this plan specified a **detached** worker (setsid, Unix
socket, daemon adoption) so that in-flight turns survive daemon replacement.
That was revised to the in-process model after three findings: (a) the reference
ACP clients run adapters in-process and recover from client restarts purely via
persisted session id + lazy `session/load` — a complete, proven recovery loop;
(b) the crash-recovery machinery is required in both models (a detached worker's
crash needs the identical cold path), so detach only ADDS the socket/registry/
adopt/handshake layer for one scenario; (c) the owner accepted turn-interruption
on daemon deploy as a fair trade for the removed complexity. The detach seam is
preserved (worker = separate process, RPC transport swappable).

## Why not the other options

**ACP inside the daemon process:** couples the ACP SDK stack into both daemon
twins, doubles the maintenance surface, and a bug in ACP handling can kill the
daemon (and with it every native Claude subscription on the host). The separate
worker keeps blast radius per-session at negligible cost.

**A shared machine-wide ACP process:** couples unrelated sessions through one
failure domain, one upgrade boundary, one set of pending requests, and
potentially conflicting working directories and permissions. Per-session workers
make cleanup, attribution, and recovery local.

**Detached workers (the earlier decision):** see the revision note. Deferred,
not rejected — the appendix records the design and its exit test.

## UX And E2E Scenarios

All browser scenarios begin on the Homepage session panel. The dedicated
Sessions page receives parity coverage second.

### 1. Start a Codex session

1. Open Quick Start through the UI.
2. Choose Codex in the provider segmented control.
3. Choose a working directory and send a prompt.
4. Verify the pending panel becomes a Codex session.
5. Verify text, reasoning, tool activity, usage, and turn completion stream in
   the existing session panel.
6. Verify the task and session records persist `engine=codex`.

### 2. Continue the warm session

1. Send a follow-up from the same panel.
2. Verify no new worker, adapter, or provider session is created.
3. Verify the same ACP session ID and Codex thread ID are used.
4. Verify only the new turn is appended.

### 3. Switch providers without mixing history

1. From the same task, start a new session using Claude.
2. Verify Claude and Codex appear as separate session rows.
3. Verify each row opens its own history and process controls.
4. Verify sending to one session never changes the other provider's state.

### 4. Approval and elicitation

1. Make the mock ACP agent request a tool permission.
2. Verify the session pauses and the Homepage panel shows the provider's
   returned options.
3. Approve once and verify the exact ACP option ID returns to the worker.
4. Repeat with reject.
5. Verify pending requests survive a Walnut web-server restart (worker holds
   them; server re-reads on reattach).

### 5. Interrupt

1. Start a streaming turn with a long-running tool.
2. Click Stop.
3. Verify `session/cancel` reaches the adapter, the turn becomes cancelled, and
   the worker stays alive for the next prompt.

### 6. Web server restart

1. Start a turn and wait for several streamed events.
2. Restart only the Walnut web server.
3. Let the worker (still alive under the daemon) complete the turn.
4. Reconnect through the UI.
5. Verify replay is gap-free, ordered, and duplicate-free.

### 7. Daemon restart (cold-resume contract)

1. Start a turn.
2. Kill and restart the daemon (worker and adapter die with it).
3. Verify the UI shows the turn as interrupted — honestly, promptly, with no
   stuck spinner and no dead approval buttons.
4. Send the next message.
5. Verify a fresh worker starts, `session/load` restores completed history, and
   the new prompt runs on the same provider thread.

### 8. Worker crash recovery

1. Complete one turn, then terminate the worker process directly.
2. Send another message.
3. Verify Walnut starts a replacement worker and calls ACP `session/load`.
4. Verify completed history is restored.
5. If a turn was active during the crash, show it as interrupted rather than
   claiming successful completion.

### 9. Missing or unauthenticated provider

1. Test a host without the codex binary and verify a clear startup error, with
   no stuck pending session.
2. Test missing authentication and verify the provider's auth-required state is
   surfaced without leaking credentials into logs; the session parks rather than
   crash-looping.

## Pseudocode

### Start

```text
on quickStart(engine, cwd, prompt):
  runtimeId = newRuntimeId()
  persistPendingSession(runtimeId, engine, cwd)

  daemon.acpStart(runtimeId, cwd)        # spawns worker child
  worker.initialize()
  providerSessionId = worker.newSession()

  persistReadySession(runtimeId, providerSessionId)
  worker.prompt(commandId, prompt)
```

### Lazy resume (after daemon restart, worker crash, or idle cull)

```text
on prompt when no live worker for runtimeId:
  daemon.acpStart(runtimeId, cwd)
  worker.initialize()
  ok = worker.loadSession(providerSessionId)   # retries
  if not ok:
    providerSessionId = worker.newSession()    # visible warning
  worker.prompt(commandId, prompt)
```

### Daemon startup repair

```text
on daemon startup:
  for each worker registry entry:
    if pid+start-time not alive: (always true after restart)
      if entry.inFlight:
        journal.appendMeta(runtimeId, 'turn-interrupted', 'daemon-restart')
      if entry.pendingPermission:
        journal.appendMeta(runtimeId, 'permission-auto-cancelled')
      remove entry
```

### Permission

```text
on ACP permission request (worker):
  record in pending table
  journal.append({kind:'acp', frame})
  # server normalizes -> SESSION_PERMISSION_REQUEST bus event -> UI

on user decision (server -> daemon -> worker):
  worker.permissionResponse(commandId, providerRequestId, optionId)
  journal.appendMeta('command-accepted')
  reply to the live ACP JSON-RPC request with the exact option ID
```

## Implementation Phases

### Phase 0: Cleanup and docs

- Delete the one-shot `CodexCliSession` scaffold; revert the binary-passthrough
  change in the native transport (a binary-name parameter is not a provider
  abstraction).
- Remove the hard-coded Codex model catalog; keep `SessionEngine` and
  `SessionRecord.engine`.
- This document + decision skill updated to the in-process model.

Exit condition: no production path can start Codex through the Claude FIFO
transport; native suites unchanged.

### Phase 1: ACP host worker

- New `src/providers/acp-worker/`: worker entry (NDJSON JSON-RPC over stdio),
  journal module, commandId dedup, adapter spawn + version/auth preflight.
- Pin `@agentclientprotocol/sdk` and `@agentclientprotocol/codex-acp` exact
  versions.
- Scripted fake ACP agent (`tests/providers/mock-acp-agent.mjs`, mirroring
  `mock-claude.mjs`) + worker unit tests: new/prompt/stream, load-resume,
  permission round-trip, cancel, dedup, replay-from-offset, truncated-tail
  tolerance.

Exit condition: worker-level tests pass with the scripted fake ACP agent.

### Phase 2: Daemon integration

- `daemon-core.ts`: worker spawn/supervision, registry persistence, idle timer,
  startup sweep + repair.
- `daemon-standalone.ts` + `daemon-source.ts` (twins in sync): `acpStart`,
  `acpSend`, `acpCancel`, `acpRespond`, `acpState`, `acpStop` command cases;
  journal tailing through the existing subscriber replay/push machinery.
- `daemon-capabilities.ts`: add `acp-v1` (forces auto-redeploy).
- `build-daemon.sh` + `daemon-version-check.ts`: bundle the worker artifact,
  include worker sources in the version hash.
- Daemon-level E2E with the fake agent: stream, daemon kill → chain dies,
  restart → repair marks interrupted, next start → lazy resume.

Exit condition: daemon E2E green including crash-repair and lazy-resume.

### Phase 3: Walnut session integration

- `AcpSession` implementing the existing session contract; pure
  `acp-stream-normalizer.ts`; `engine` threaded through `SessionStartEvent`,
  quick-start, and the WS RPC; `SessionRunner` dispatch branch; engine
  persistence in the session tracker; permission bridge onto the existing
  permission route; lazy resume in `send()`.
- Server E2E through `startServer({port:0,dev:true})` with only the agent
  binary mocked.

Exit condition: server E2E green; native Claude suites untouched and green.

### Phase 4: Homepage UX

- Engine segmented control in Quick Start; engine badge on session rows (both
  surfaces: Homepage panel primary, Sessions page parity).
- Models/modes from capability discovery; hide unsupported controls instead of
  emulating Claude-only behavior.
- Playwright through visible controls, no direct route navigation.

Exit condition: Playwright green on quick-start, permission, and interrupt
flows with the mock adapter.

### Phase 5: Real Codex verification

- Gated live test against the pinned adapter and a real Codex login: model
  discovery, one approval, one file edit, interrupt, warm follow-up, web-server
  restart, daemon restart + lazy resume of the same thread.
- Record adapter, SDK, and Codex versions in diagnostics.

Exit condition: the same live thread continues after both web-server restart
and daemon-restart lazy resume.

## Deferred Work (explicitly out of scope)

- **Detach upgrade** (appendix below).
- **Remote-host deploy**: multi-target worker binaries and a content-addressed
  provider-runtime bundle (codex binary rides the pinned deployment unit —
  `codex-acp` hard-depends on `@openai/codex`, so a separately installed binary
  is valid only with exact-version verification before session start).
- **Claude ACP backend**: `claude-agent-acp` through the same worker, opt-in +
  CI-exercised conformance fixture (drives BOTH adapters on every worker
  change, with a retirement tripwire), no scheduled default flip, existing
  native sessions never converted.

## Appendix: deferred detach upgrade

The in-process worker preserves the seam: worker is already a separate process;
its RPC transport (stdio) can be swapped for a Unix socket without changing the
op protocol. If turn-survival-across-daemon-replacement ever becomes worth the
complexity, the upgrade adds: setsid spawn + pgid files, a worker registry with
adoption (pid + start-time validation), socket reconnect, and an attach
handshake (`controlProtocolVersion`, `journalVersion`, builds, supported ops;
incompatible workers surface constrained/read-only, never killed to upgrade).
Its exit test: an in-flight fake-agent turn survives daemon replacement. Note
the idle timer moves from daemon to worker in that model. Do not build any of
this unless the decision is explicitly reopened.

## Verification Matrix

```text
Layer                    Required verification
-----------------------  -----------------------------------------------
Worker protocol          Unit tests with scripted ACP requests/updates
Worker lifecycle         Child-process + journal integration tests
Daemon protocol          Standalone/source parity and capability tests
Session coordinator      E2E server tests; only agent binaries are mocked
Homepage UI              Playwright through visible controls
Codex compatibility      Gated live test with pinned versions
```

Build verification remains:

```text
npm run lint
npm test
npm run test:e2e
npm run web:build
bash scripts/build-daemon.sh
```

## Risks And Controls

- **Adapter drift:** pin versions and test generated capabilities; upgrades are
  explicit compatibility changes.
- **Turn loss on daemon deploy:** accepted by decision; controlled by honest
  interrupted-turn repair, lazy resume, and (optional, later) a deploy-time
  drain that defers the daemon swap while an ACP turn is active.
- **Duplicate turns on retry:** commandId idempotency at the worker.
- **Duplicate replay:** byte-offset cursor over the journal; adapter-side
  history replay suppressed during session/load.
- **Lost approvals:** worker owns the live ACP callback; daemon-restart repair
  auto-cancels visibly; journal meta facts close replayed requests.
- **Cross-provider leakage:** one worker per session and provider-specific
  environment construction.
- **Resource growth:** per-host cap on sessions with a live adapter, enforced
  at spawn, surfaced in the UI; idle culling frees slots.
- **Public packaging:** ship public dependencies and generic documentation only;
  no environment-specific repository or installation references.

## References

- https://github.com/agentclientprotocol/agent-client-protocol
- https://github.com/agentclientprotocol/codex-acp
- https://github.com/agentclientprotocol/claude-agent-acp
- https://developers.openai.com/codex/app-server
- `src/providers/session-manager.ts`
- `src/providers/daemon-standalone.ts`
- `src/providers/daemon-source.ts`
- `src/providers/daemon-core.ts`
