# Agent Provider Platform

> Status: P0 (capability registry, `src/core/agents/engine-registry.ts`) and the first P1 slice (unified `agent.*` daemon command family, `src/providers/agent-command-map.ts`, capability `agent-commands-v1`) are implemented. The shared supervisor extraction, P2+ phases, and server-side adoption of `agent.*` are not.
> Scope: turn Walnut's two hardcoded coding-agent engines (`claude`, `codex`) into an open set of engines (add `opencode`, `cursor`, `gemini`, others) that share ONE core in the daemon, ONE canonical event vocabulary, and ONE capability contract.
> Reference studied: T3 Code (`apps/server/src/provider/`), which ships 5 providers behind one driver SPI.

## Executive summary

1. Walnut already has the two hard parts of a multi-engine platform: a canonical session event vocabulary (31 `session:*` bus events, deliberately ACP-shaped) and a journal-plus-projector pattern where the daemon records raw provider frames and the server derives canonical events. What is missing is a **provider contract**: engine-specific facts live as `engine === 'codex'` string tests spread across roughly 65 files, and the daemon carries two parallel command families (`start/send/stop/...` for the Claude CLI, `acpStart/acpSend/acpStop/...` for ACP). A third engine would add a third family and a third set of branches.
2. The fix is a **descriptor plus capability record per engine**, registered in one file, so no call site ever branches on an engine name again. Every current branch is really asking one of nine capability questions (steering, permission shape, history source, id provisioning, rewind, health probe, mode control, external import, skill sync). Capabilities answer them uniformly, and a new engine ships by adding a descriptor rather than by editing session lifecycle code.
3. The daemon keeps ownership of every process, and gets **one command family** (`agent.*`) with three transport strategies behind it: stream-json over a FIFO (Claude CLI today), ACP over a worker's stdio (Codex today, plus Cursor, Gemini, Grok with almost no new code), and a managed local HTTP server with an event stream (OpenCode). Supervision (idle reaping, process-group adoption, startup repair, journal tailing) is written once and shared by all three, instead of being duplicated per transport as it is today between `daemon-core.ts` and `acp-daemon.ts`.
4. Remote parity is part of the contract, not a later patch. ACP sessions today work only on hosts running the compiled daemon; the SSH-deployed fallback twin answers `acp_unsupported`. The platform must state, per engine and per host, whether the engine is available, and degrade with a clear reason instead of a raw error.
5. What Walnut should NOT copy from T3 Code: its remote model (one full server per environment) and its in-process SDK adapters. Walnut's daemon plus process adoption survives server restarts and SSH drops, which is a stronger guarantee than a per-environment server, and running an agent SDK inside the server process would put agent work back on the event loop the web routes share.
6. Suggested order: contract and capability registry first (pure refactor, no behavior change), then the unified daemon command family, then remote parity, then OpenCode as the first genuinely new transport shape, then the provider catalog UI (installed, version, auth, models) and finally multiple instances of one engine.

## Where we are today

| Seam | Location | State |
|---|---|---|
| Engine axis | `SessionEngine = 'claude' \| 'codex'` (`src/core/types.ts:1499`) | Closed union. Note `SessionProvider` is already taken for a different axis (`'cli' \| 'sdk' \| 'embedded'`, the execution substrate), so `engine` stays the vendor key. |
| Engine branches | ~30 direct `engine === 'codex'` tests in `src/core/**`, `src/web/routes/**`; 65 files mention codex at all | Each one encodes a capability fact in prose. |
| Claude runtime | `src/providers/claude-code-session.ts` (10,151 lines) | Transport, queue, echo claims, idle accounting, usage, title, catalog, all in one class. |
| ACP runtime | `src/providers/acp-session.ts` (1,698 lines) plus `acp-daemon.ts` (751) plus `acp-worker/` (1,477) | Thin server class, daemon owns the worker, journal is source of truth. This is the shape to generalize. |
| Canonical events | `src/core/event-types.ts` (31 `session:*` events), `acp-stream-normalizer.ts`, `claude-stream-event-map.ts` | Already provider-neutral. Keep. |
| Daemon commands | `src/providers/daemon-standalone.ts:1417-1487` | Two families, one per transport. |
| Remote parity | `src/providers/daemon-source.ts:2002-2012` | JS twin rejects all `acp*` commands. |
| Provider health | none | No "is this engine installed / authed / what version / which models" concept. The model picker hardcodes per-engine knowledge. |

## What T3 Code does, and which parts to take

Worth taking:

- **Driver as a plain value, not a service.** A driver is a record with `kind`, `metadata`, a config schema, and `create(input)` returning one instance. Instances are created per configuration and torn down by closing their scope. Walnut's equivalent: a descriptor record plus a factory, registered in one array (`BUILT_IN_DRIVERS` is their whole registration story, `builtInDrivers.ts` is 54 lines of real content).
- **A capability record on the adapter.** They expose `capabilities.sessionModelSwitch: 'in-session' | 'unsupported'` so call sites ask the capability, not the vendor. Walnut needs the same idea with more axes.
- **A canonical runtime event union with the raw frame attached.** Their `ProviderRuntimeEvent` carries `provider`, ids (`threadId`, `turnId`, `itemId`, `requestId`), provider-native ids under `providerRefs`, and an optional `raw` envelope tagged with its source (`claude.sdk.message`, `opencode.sdk.event`, `acp.jsonrpc`, and so on). Walnut's journal records already do the raw half; the canonical half exists as bus events but is not a single typed union with provider ids on it.
- **Unavailable instances stay visible.** A configured provider whose driver is missing in this build becomes a shadow snapshot marked unavailable rather than disappearing. That is exactly the behavior Walnut needs for "engine not installed on this host".
- **One shared snapshot machine.** `makeManagedServerProvider` gives every driver the same polling, refresh, settings-change reaction, and change stream. Per-driver code only supplies the probe.
- **Maintenance as data.** Install and update capability is declared per engine (package name, formula, native update command) rather than written as per-engine procedures.

Not worth taking:

- **Environment equals one server.** Their remote story is "run another whole server and connect a WebSocket to it". Walnut's daemon plus FIFO plus process-group adoption already survives more failures, and the daemon is far cheaper to deploy than a full server.
- **In-process SDK adapters.** Their Claude driver runs the Agent SDK inside the server. Walnut deliberately keeps agent processes out of the server process (one blocked event loop stalls every route).
- **Effect-based dependency injection.** The value is the shape (records, explicit dependencies, scoped teardown), not the framework. Plain factories and an explicit registry give the same seams here.

## Target architecture

### Layers

```text
┌───────────────────────────────────────────────────────────────┐
│ L4  Surfaces: web console, iOS, cloud replica, CLI, MCP       │
│     ask capabilities, never the engine name                   │
└───────────────────────┬───────────────────────────────────────┘
                        │  /api/providers, session events
┌───────────────────────▼───────────────────────────────────────┐
│ L3  Server: AgentSession (generic) + per-engine projector      │
│     queue, echo claims, titles, task phase, snapshots          │
└───────────────────────┬───────────────────────────────────────┘
                        │  ONE daemon command family: agent.*
┌───────────────────────▼───────────────────────────────────────┐
│ L2  Daemon: supervisor (idle reap, adopt, repair, journal tail)│
│     + 3 runtime strategies                                     │
│       a) stream-json over FIFO      (claude CLI)               │
│       b) ACP worker over stdio      (codex, cursor, gemini…)   │
│       c) managed HTTP server + SSE  (opencode)                 │
└───────────────────────┬───────────────────────────────────────┘
                        │  journal (append-only, byte-offset cursor)
┌───────────────────────▼───────────────────────────────────────┐
│ L1  Contract: engine descriptor + capabilities + canonical     │
│     event union. Shared by server, both daemon twins, web, iOS │
└───────────────────────────────────────────────────────────────┘
```

### The contract (L1)

One module (proposed `src/core/agents/`) holds, for each engine:

- **Identity**: engine id (open string, not a union), display name, accent, icon key.
- **Transport**: which L2 strategy runs it, plus the launch recipe (binary resolution, adapter command, server command, env).
- **Identity semantics**: whether Walnut can preassign the session id or must learn it from the provider (today: Claude preassigns, ACP learns), and where resumable history lives.
- **Capabilities**, one boolean or small enum per question that a call site asks today:

| Capability | Replaces the branch in |
|---|---|
| `midTurnSteer` | `acpSteer` capability gate, mid-turn injection path |
| `permissionShape: 'modes' \| 'options'` | permission apply and resolve paths (`session-lifecycle.ts`, `session-extras.ts`) |
| `historySource: 'provider-jsonl' \| 'journal'` | `session-lifecycle.ts:56`, history read |
| `idProvisioning: 'preassigned' \| 'provider-issued'` | `task-start.ts:123`, `mobile-launch.ts:238` |
| `modeControl` | provider-advertised control apply (`session-extras.ts:66`) |
| `rewind: 'fork' \| 'none'` | `session-rewind.ts:171` |
| `healthProbe: 'pid+jsonl' \| 'worker-state'` | `session-health-monitor.ts:1113,1456` |
| `externalImport` | `external-session-scan-core.ts`, import naming |
| `skillSync`, `slashCommands`, `imageInput`, `modelSwitchInSession`, `usageReporting`, `checkpoints` | skill sync, composer affordances, model picker, context percentage |

- **Catalog source**: how models and options are discovered (provider-advertised for ACP, configured list for the Claude CLI, HTTP query for OpenCode).
- **Maintenance**: how to detect installation and version, and how to update, declared as data.

Adding an engine means adding one descriptor plus, at most, one projector. It must not mean editing session lifecycle, health monitor, task start, or the model picker.

### The daemon core (L2)

```text
agent.start   agent.send    agent.steer   agent.cancel
agent.respond agent.setOption agent.state  agent.stop
agent.subscribe agent.history
        │
        │ { engine, runtimeId, ... }
        ▼
┌──────────────────────────────────────────────┐
│ AgentSupervisor (one implementation)         │
│  idle reap, turn-open ceiling, pgid registry │
│  adopt-on-restart, startup repair,           │
│  journal append + tail + offset cursor       │
└───────┬───────────────┬──────────────┬───────┘
        ▼               ▼              ▼
  FIFO stream-json   ACP worker    HTTP server
  (claude CLI)       (stdio RPC)   (opencode)
```

Rules the current code already proves are load bearing, and which the shared supervisor must keep:

- The journal, not memory, is the source of truth, and a byte offset is the replay cursor. One atomic write per record so a reader never sees a torn boundary.
- Every death path funnels into one reap that normalizes a clean turn end to exit 0, so a turn end never renders as a crash.
- A session parked on a permission request is not idle. Two ceilings: idle and turn-open.
- Startup repair scans journal tails and closes un-ended turns and un-answered permissions, so the UI never shows a stuck spinner after a daemon restart.
- New commands are capability gated (`daemon-capabilities.ts`) so an old daemon degrades instead of erroring. The `agent.*` family ships alongside the existing two families, which become thin aliases and are removed only after every daemon in the fleet advertises the new family.

### The server (L3)

`AgentSession` owns everything that is not transport: the disk-backed message queue, echo claims, optimistic dedup, titles, task phase pullback, snapshot projection, usage. Per engine, only a projector (raw journal records to canonical events) and a launch argument builder remain. This is the direction the ACP work already took (1,698 lines against the Claude class's 10,151); the platform work is mostly moving generic logic out of `claude-code-session.ts` into the base rather than writing new code.

### Availability and the catalog (L3 to L4)

`GET /api/providers` returns, per host and engine: installed, version, authenticated, models, capabilities, plus an `unavailable` reason when the host cannot run it. This one endpoint feeds the model picker, the draft composer, the iOS engine picker, and the "engine not available on this host" empty states, and removes the last reason for a surface to hardcode engine knowledge.

## UX scenarios

1. **Start a session, pick an engine.** The draft composer lists engines from the catalog for the selected host, with unavailable ones shown greyed with a reason ("not installed on this host", "sign in required"), never hidden and never a raw error.
2. **Engine missing on a remote host.** Picking it explains what is missing and offers the install action when the descriptor declares one; the session is not created in a broken state.
3. **Permission prompt.** Claude prompts as modes, ACP as options, OpenCode as a permission rule reply. The UI renders from the canonical request event, so all three look native and the approve and deny paths agree on what "withdrawn" means (already distinguished from "denied" today).
4. **Mid-turn message.** Where the engine supports steering, the message lands inside the running turn. Where it does not, the composer says the message is queued for the next turn instead of silently waiting.
5. **Model switch.** The picker shows the catalog the engine advertised, and switching in session is offered only when the capability allows it.
6. **Daemon restart mid-turn.** Every engine behaves the same: history survives on disk, the turn is closed by startup repair, and the next message resumes the provider session.
7. **Rewind.** Offered only for engines whose descriptor declares fork-based rewind.

## Phases and acceptance gates

| Phase | Content | Gate |
|---|---|---|
| P0 | Contract module, descriptors for the two existing engines, capability registry; delete every `engine === 'codex'` branch in favor of capability reads. No behavior change. | Full existing suite at baseline; a grep gate test that fails if a new `engine === '...'` test appears outside the descriptor module. |
| P1 | `agent.*` command family in both daemon twins, shared supervisor extracted from `daemon-core.ts` plus `acp-daemon.ts`, both old families become aliases, capability gated. | Live daemon tests for both engines, restart and adoption tests, old-daemon degrade test. |
| P2 | Remote parity: worker artifact deployed by the existing chunked auto-deploy, ACP available on remote hosts, catalog reports per-host availability. | Live cross-machine test: start a Codex session on a remote host, survive a daemon replacement. |
| P3 | OpenCode engine (managed HTTP server strategy plus SSE projector). First proof that a new transport shape needs no core edits. | End-to-end session on OpenCode: send, stream, permission, cancel, resume after daemon restart. |
| P4 | Provider catalog and maintenance surfaces (installed, version, auth, models, update), model picker driven entirely by the catalog. | Playwright run over picker and empty states; no engine literal left in `web/src`. |
| P5 | Multiple instances per engine (two accounts, two binaries), routing key becomes (host, engine, instance). | Two instances of one engine live at once with no shared state. |

ACP-based engines (Cursor, Gemini, Grok) are descriptor-only work once P1 and P2 land, and can be slotted in wherever the demand is; they do not need their own phase.

## Risks and decisions

- **Instances now or later.** T3 Code routes by `instanceId` from the start and pays a migration tax for it (their code carries "legacy kind-keyed" shims everywhere). Recommendation: keep (host, engine) as the routing key through P4 and introduce instances in P5, but reserve the field in the contract so the later change is additive.
- **Do not rename `engine` to `provider`.** `SessionProvider` already means the execution substrate in Walnut, and the ACP work already learned that a repository-wide identity rename is not worth it (`claudeSessionId` still carries the ACP session id).
- **Do not make ACP the universal internal protocol.** Walnut's canonical vocabulary is already ACP-aligned, which is the useful part. Forcing the Claude CLI path through ACP semantics would put an adapter in front of the most battle-tested code in the repo and lose behavior that has no ACP expression (idle debt accounting, compact usage re-seed, disk queue semantics).
- **Transport count is the real cost driver.** Three strategies is the honest number today. Each new engine should be forced to answer "which existing strategy do you use" first; a fourth strategy needs an explicit decision, not a quiet addition.
- **OpenCode specifics to verify before P3.** Server lifetime per project directory versus per session, auth and model discovery, whether an externally started server should be reused, and how its permission replies map onto the canonical request event.

## Appendix: shape sketches

```text
descriptor = {
  id, displayName, transport: 'fifo-stream-json' | 'acp-worker' | 'http-server',
  launch: { resolveBinary, buildArgs, env, adapterCmd? , serverCmd? },
  identity: { idProvisioning, historySource, resumeMode },
  capabilities: { midTurnSteer, permissionShape, modeControl, rewind, ... },
  catalog: { source: 'provider-advertised' | 'configured' | 'http', ... },
  maintenance: { versionProbe, updateRecipe? },
  projector: (journalRecord) => CanonicalEvent[],
}

registry = [claudeDescriptor, codexDescriptor, opencodeDescriptor, ...]

// call sites stop asking the vendor
if (engineCaps(record).midTurnSteer) { ... }        // instead of engine === 'codex'
```

Checklist for adding an engine after P3: write the descriptor, pick a transport strategy, write the projector if the transport does not already have one, add the maintenance data, add a live test to the provider matrix. No edits to session lifecycle, health monitor, task start, queue, or the model picker.
