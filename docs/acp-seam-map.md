# ACP Adapter ↔ Walnut Seam Map

Walnut's streaming/session layer deliberately mirrors the **Agent Client
Protocol** vocabulary (github.com/agentclientprotocol/claude-agent-acp — Zed's
adapter for Claude Code). Both projects drive the same CLI over stream-json and
therefore fight the same race conditions (out-of-order events, replays, cancel
leftovers, compact rewrites). This table maps each adapter mechanism to its
Walnut counterpart so an upstream bug fix can be ported at the *mechanism*
level in minutes.

**How to use (weekly CHANGELOG scan / manual porting):**
1. Read the upstream fix; identify which mechanism row it touches.
2. Open the Walnut location in that row; port the *idea*, not the diff —
   process models differ (adapter = same-machine stdio child; Walnut =
   daemon + FIFO + process adoption), so code never transplants verbatim.
3. If the row says "not ported", decide whether the fix justifies porting the
   whole mechanism now.

## Wire vocabulary (aligned — same semantics, same natural keys)

| ACP concept | Walnut equivalent |
|---|---|
| `agent_message_chunk { messageId }` | `SESSION_TEXT_DELTA.msgId` (`src/core/event-types.ts`) — same API `msg_…` id |
| `agent_thought_chunk { messageId }` | `SESSION_THINKING_DELTA.msgId` |
| messageId change ⇒ new message boundary | same rule in `src/web/session-stream-buffer.ts` (`appendTextDelta`) and the frontend twins (`web/src/hooks/useSessionStream.ts`, `web/src/cache/session-cache.ts`) |
| `tool_call` / `tool_call_update { toolCallId }` | `SESSION_TOOL_USE` / `SESSION_TOOL_RESULT` (`toolUseId` was always the shared key) |
| turn end (`stopReason`) | `SESSION_RESULT` (result handler in `src/providers/claude-code-session.ts`) |
| `usage_update` | `SESSION_USAGE_UPDATE` |
| `session/request_permission` | `SessionPermissionRequestEvent` / `SessionPermissionResolvedEvent` |
| snapshot freshness | `StreamSnapshot.seq` (monotonic buffer mutation counter) |

## Mechanisms (ported)

| Adapter mechanism | What it solves | Walnut counterpart |
|---|---|---|
| Idle accounting ("every result owes one idle") | late companion idle misread as the next turn's turn-over | `_idleDebt` in `src/providers/claude-code-session.ts` (banked in the FIFO-alive result branch, consumed first in the `session_state_changed{idle}` handler); tests: `tests/providers/session-idle-debt.test.ts` |
| promptUuid echo handshake (user-message identity) | which persisted user line is *my* message | `src/core/echo-claims.ts` — FIFO-order binding of `qm-…` queue ids to canonical JSONL uuids at history parse; consumed by `web/src/components/sessions/optimistic-dedup.ts` |
| Message-boundary grouping by messageId | consecutive messages' text glued into one block | boundary rule in `session-stream-buffer.ts` + frontend twins (see wire table) |
| Post-compact authoritative usage pull | context % frozen at pre-compact value | `compact_boundary` handler → `getContextUsage()` re-seed (`claude-code-session.ts`) |
| Force-cancel backstop (30s armed timer) | interrupt that never lands ⇒ hang forever | **already equivalent, nothing ported**: daemon `cmdStop` runs SIGINT → 5s → SIGTERM → 2s → SIGKILL on the process group (`src/providers/daemon-standalone.ts`) |
| Single renderer for replay + live | replay parsed by a second code path drifts from live | **not adopted as-is** — Walnut keeps two derivations (JSONL parser + live deltas) reconciled by id: `web/src/cache/promote-blocks.ts` (id-first promotion), `web/src/cache/snapshot-adoption.ts` (seq), guarded at runtime by the convergence sentinel `src/core/observability/stream-convergence.ts` |

## Mechanisms (not ported — open)

| Adapter mechanism | What it solves | Where it would land |
|---|---|---|
| pendingOrphanResults (skip-N accounting after cancel) | a cancelled queued prompt's result mis-attributed to the next turn | result handler in `claude-code-session.ts` (near the replay/stale-result guards) |
| Husk-session fail-fast | a dead-on-arrival session hangs instead of failing | spawn/init path in `claude-code-session.ts` (init-timeout handling exists; husk detection does not) |

## Structural differences (do NOT try to align these)

- **Process model**: adapter is a same-machine stdio child (parent dies ⇒ CLI
  dies, no detach). Walnut's daemon + FIFO + pgid adoption survives daemon
  restarts and SSH drops. Fixes in the adapter's transport/lifecycle layer
  (AbortController trees, SDK reconnects, stdio EOF handling) have no Walnut
  counterpart and need none.
- **Turn queue**: adapter queues prompts in memory; Walnut queues on disk
  (messages survive crashes). Queue-semantics fixes port as *ideas* only.
- **Concurrent prompt folding**: adapter folds overlapping prompts (ambiguous
  turn attribution); Walnut injects mid-turn via FIFO write. Do not import
  their folding semantics.
