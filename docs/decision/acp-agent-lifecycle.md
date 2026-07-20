# ACP Agent Lifecycle

Status: accepted, revised 2026-07-18.

Supersedes the earlier Codex-specific decision to use detached ACP host workers.
There is no separate current Codex lifecycle decision.

## Summary

Codex sessions run through ACP (`@agentclientprotocol/codex-acp`, driven by
`@agentclientprotocol/sdk`). Each Walnut session gets one ACP host worker: a
separate process, but an ordinary daemon child that dies with the daemon. The
worker owns the ACP connection, adapter child, pending requests, `commandId`
deduplication, and an append-only journal containing raw frames and observed
meta facts, with a byte-offset cursor and atomic appends.

Daemon crash or restart recovery is lazy cold resume. Startup repair marks
in-flight turns interrupted and automatically cancels pending permissions. The
next message starts a fresh worker and calls ACP `session/load` with the
persisted provider session ID.

Native Claude keeps its daemon and FIFO path unchanged. Claude over ACP remains
deferred. If implemented, it must be opt-in and covered by a CI conformance
fixture; it must never be introduced as a scheduled default flip.

The authoritative implementation plan is the
[coding-agent ACP provider plan](../plan/coding-agent-acp-provider.md).

## Revision History

- **2026-07-18:** Changed from detached per-session workers to daemon-owned
  child workers. Two multi-model review rounds had converged on detachment
  earlier that day; the product decision was then made to prefer the simpler
  daemon-owned lifecycle. The other conclusions remain: journal grammar,
  normalize-on-read purity, `commandId` idempotency, identity separation,
  pinned deployment, capability discovery, and the Claude-ACP policy.
- **Earlier 2026-07-18:** The superseded Codex-specific decision selected
  detached workers. Its useful rationale is retained here and in the plan's
  deferred-detach appendix; the old pointer skill has been removed.

## Context

The decision is not between recovery and no recovery. Both daemon-owned and
detached workers require durable journals, startup repair, lazy
`session/load`, and honest interrupted-turn state. A detached worker also needs
an adoption transport and lifecycle protocol.

## Evidence

- Reference ACP clients run adapters as ordinary child processes and recover
  client restarts from a persisted session ID plus lazy `session/load`.
- The complete recovery loop is sufficient: startup repair changes stuck turns
  to error, cancels pending approvals, preserves the provider session ID, and
  resumes on the next message.
- A detached ACP worker does not enable hot reattachment to the existing
  adapter. `codex-acp` terminates its app-server shortly after ACP stdin closes,
  so worker failure still requires the same cold recovery path.
- Detachment therefore adds a Unix socket, reconnect protocol, adoptable worker
  registry, process-group probes, and a versioned attach handshake primarily to
  preserve in-flight turns across daemon replacement.

## Decision

- Run one separate ACP host worker per Walnut session.
- Keep that worker as an ordinary daemon child.
- On daemon replacement, mark any active ACP turn interrupted rather than
  pretending it survived.
- Recover lazily on the next send by creating a worker and loading the
  persisted provider session.
- Keep the worker boundary so the ACP SDK ships in one artifact, a worker crash
  cannot terminate the daemon, and the stdio RPC boundary can later become a
  socket if the detach decision is reopened.

## Do Not Rebuild

- Do not restore the one-shot `CodexCliSession` or `codex exec --json` model.
- Do not add a binary-name parameter to the native Claude transport; swapping a
  binary is not a provider abstraction.
- Do not feed Codex or ACP frames through Claude's FIFO or session manager.
- Do not build socket adoption, a detached registry, attach handshakes, or
  process-group probes unless this decision is explicitly reopened against the
  plan's exit criteria.
- Do not put the ACP SDK into both daemon twins. It belongs in the worker
  artifact.
- Do not share one ACP adapter process across unrelated Walnut sessions.
- Do not hard-code a Codex model catalog. Discover models from ACP
  capabilities.
- Do not switch a live Walnut session between engines. Create a sibling
  session, and never transplant histories.
- Do not journal interpreted state. Journal raw frames and worker-observed meta
  facts; normalize with a pure server-side read function.
- Do not schedule a Claude-ACP default flip or convert existing native Claude
  sessions.

## References

- [Coding-agent ACP provider plan](../plan/coding-agent-acp-provider.md)
- [ACP worker implementation](../../src/providers/acp-worker/)
- [Agent Client Protocol Codex adapter](https://github.com/agentclientprotocol/codex-acp)
- [Agent Client Protocol Claude adapter](https://github.com/agentclientprotocol/claude-agent-acp)
- [Codex app-server](https://developers.openai.com/codex/app-server)
