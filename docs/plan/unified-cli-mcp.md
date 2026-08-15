# Unified Walnut CLI + MCP: one operation registry, reachable from every session on every host

## Executive summary

Today the agent-facing surface is fragmented: the CLI has 7 commands, the MCP server has 10 hand-written tools, the server exposes ~130 `/api/v1` endpoints, and the skill teaches raw `curl`. Each grew separately, so they drift, and remote hosts have nothing at all.

The proposal: ONE operation registry in the repo becomes the single source of truth for the agent-facing contract. The CLI, the MCP server, the in-session `wn` shim, and the generated docs all render from it. Reach is two transports behind one client: direct HTTP when the server is reachable, and the existing daemon gateway socket when running inside any Walnut-managed session (local or remote). Capability parity with the server is guaranteed from day one by a generic passthrough op, while the curated surface grows incrementally.

Recommended design: Design 2 (shared registry) with dual transport (iii). Details and rejected alternatives below.

## The four requirements (user-stated)

1. CLI and MCP are the same thing: one binary, usable both as an MCP server and as a CLI (the `tools list / tools help / tools call` pattern).
2. The operation set should ideally be generated from the API we design, with room for customization where needed.
3. It should have the same capability the server has.
4. Every session or agent on the laptop can call it, and agents on remote SSH hosts can call it through the daemon.

## Current state (verified in source)

| Surface | Size | Source of truth | Problems |
|---|---|---|---|
| `/api/v1` REST | ~130 endpoints, 20 route files | Express handlers, ad-hoc validation | No machine-readable schema |
| CLI (`walnut`) | 7 commands | `src/commands/*.ts`, HTTP via `src/utils/api-client.ts` | Covers a fraction; missing task detail, search, memory, notes |
| MCP (`walnut mcp`) | 10 tools | `src/mcp/tools.ts`, hand-written zod + HTTP | Separate bookkeeping from CLI; drift |
| Session mount | `profiles.ts` mounts `open-walnut mcp` | | The bin name `open-walnut` is not on PATH on this machine, so the mount is dead |
| Skill | `personal-walnut/SKILL.md` | curl + jq recipes | Teaches curl because the CLI can't do the work |
| Remote hosts | nothing installed | | Requirement 4 fails entirely |
| `wn` shim | injected into EVERY session by the daemon | gateway socket → daemon → hub relay | Only knows `peers.list` / `peers.send`, but the transport is already deployed everywhere |

## Design axis 1: where does the operation set come from?

### Design 1: generate everything from the REST API (OpenAPI-first)

Annotate all v1 routes with schema metadata, generate an OpenAPI spec, then generate MCP tools and CLI subcommands from the spec at build time.

- Pros: true single source (the running API), full coverage automatically, drift is impossible by construction.
- Cons: retrofitting ~130 handlers across 20 files is a huge lift before any value lands. Generated names and descriptions are poor for LLM consumption (LLM tools need curated names, guidance like "prefer task_complete over patch", ref-tag instructions). A 1:1 mapping also explodes the tool count, and big tool lists measurably hurt tool selection. Custom semantics (complete-vs-patch, ref pills) don't fit a generator.
- Verdict: right north star for validation, wrong first step. Kept as Phase 4: the registry's endpoint bindings get CHECKED against the API (parity tests), rather than the surface being generated from it.

### Design 2 (recommended): a shared operation registry, rendered everywhere

One TS module per domain (`src/ops/tasks.ts`, `sessions.ts`, `notes.ts`, `memory.ts`, `search.ts`, `projects.ts`, `routines.ts`, `status.ts`) declaring operations:

```
defineOp({
  name: 'task_get',
  title: 'Get one Walnut task',
  description: '...curated for LLMs...',
  input: z.object({ id: z.string().min(1) }),
  bind: { method: 'GET', path: '/api/v1/tasks/:id' },   // default executor: HTTP
  tags: { readonly: true, remote: 'allow' },
  // handler?: custom executor when one HTTP call isn't enough (room for customization)
})
```

Everything renders from the registry:

- MCP: `registerWalnutTools` iterates the registry (the existing 10 tools become registry entries; behavior byte-identical).
- CLI: `walnut tools list | help <op> | call <op> '{json}'` is generated 1:1 (agents write JSON happily). Human-ergonomic flags (`walnut task list --status todo`) are generated from the zod shape for the common ops; the existing 7 commands stay as aliases.
- Docs: the skill's command tables are generated from the registry (skill becomes CLI-first, curl as fallback).
- Parity: a CI test walks the registry and asserts every binding resolves against the server's route table and that canonical fixtures validate. Drift is caught mechanically, answering requirement 2 without a full OpenAPI retrofit.

Requirement 3 (same capability as the server) is satisfied from day one by ONE generic passthrough op: `api` with input `{ method, path, body? }`, restricted to `/api/...` paths. Anything not yet curated is still reachable; curation then grows by promoting hot paths into named ops.

- Pros: single source for the agent-facing contract; curated LLM ergonomics; incremental; customization is first-class (per-op handler); one edit adds an op to CLI + MCP + remote simultaneously.
- Cons: the registry is a second declaration next to the route code, so drift is possible in principle. Mitigated by the parity CI and by the passthrough (a missing op is an inconvenience, never a capability gap).

### Design 3: status quo, just add more commands and tools by hand

- Pros: no new abstraction.
- Cons: permanent double (triple, with docs) bookkeeping. This is exactly what produced today's fragmentation. Rejected.

## Design axis 2: how do remote agents reach it?

### (i) HTTP everywhere: install the CLI remotely, tunnel back to the Mac

- Pros: same code path as local.
- Cons: needs a reverse tunnel per host, tunnel lifecycle management, and real auth (non-localhost requests do not bypass auth). Every piece is new infrastructure. Rejected.

### (ii) gateway socket only

- Pros: zero config inside sessions.
- Cons: the user's own terminal (not a Walnut-managed session) has no socket. Rejected as the only transport.

### (iii) dual transport behind one client (recommended)

The client core (registry + executor) has two interchangeable transports:

1. HTTP transport: `OPEN_WALNUT_API_URL` or localhost:3456. Used by the user's terminal, by local sessions, and by the MCP server process.
2. Gateway transport: when `WALNUT_AGENT_SOCKET` is present (the daemon injects it into every session on every host), ops are sent as a new gateway capability `tools.call {name, args}` over the existing socket → daemon → hub relay. The hub-side capability router dispatches into the SAME registry executor against its own local API.

Selection: HTTP if reachable, else gateway if the socket exists, else a clear error. The `wn` shim (already on PATH in every session, including remote) gains `wn tools ...`, so a remote agent needs ZERO installation: the transport it needs is already injected. This reuses the exact relay pattern the peers feature shipped (`gateway-request` → `DaemonConnection` → `capability-router.ts`), and old daemons degrade gracefully (unknown capability → clear "upgrade daemon" error; the auto-deploy upgrades them on next connect).

MCP for remote sessions rides the same rail: `wn mcp` runs the stdio MCP server with the gateway transport, so even a remote CLI session can mount Walnut MCP with no HTTP path to the Mac.

## Security posture

- The gateway inherits the peers model: requests carry the caller's session id; the hub enforces policy, the daemon stays an opaque relay (established pattern: the daemon allowlists the capability name, never interprets payloads).
- Per-op `tags.remote`: `allow` (default for reads and ordinary writes: the same power the local MCP mount already grants), `deny` (destructive ops: `task_delete` with force, session termination stay local-HTTP-only in v1).
- Rate limiting reuses `PeerThrottle`.

## Naming cleanup (bundled, small)

- Canonical bin: `walnut` (keep `open-walnut` as alias; both already in package.json bin).
- Fix `profiles.ts` `walnutMcpProfile()` to resolve a bin that actually exists on PATH (or an absolute path of the running install) instead of the hardcoded `open-walnut`.
- Regenerate the skill from the registry: CLI-first, curl fallback.

## Phasing

| Phase | Contents | Acceptance |
|---|---|---|
| P1 registry core | `src/ops/` registry + executor + `walnut tools list/help/call` + MCP renders from registry (10 existing tools ported byte-compatible, ~15 curated ops added: task detail/patch, search modes, memory read/write, notes read/search, session transcript, projects) + `api` passthrough + profiles.ts bin fix | CLI and MCP expose the identical op set from one file; existing MCP consumers see no behavior change; parity test green |
| P2 remote reach | gateway `tools.call`/`tools.list` capability + hub dispatch into the registry executor + `wn tools ...` + remote policy tags + daemon rebuild/auto-deploy | a remote SSH session runs `wn tools call task_list '{}'` and gets real data, zero install |
| P3 ergonomics | human flag subcommands generated from zod + skill/docs codegen + parity CI wired into the test tiers | `walnut task list --status todo` works; SKILL.md tables generated |
| P4 north star | server-side schema annotations, registry bindings validated against the generated spec | drift detection fully mechanical |

## Accepted differences

- The MCP tool count stays curated (roughly 25-35), not 130: LLM tool selection degrades with giant tool lists, and the passthrough covers the tail.
- The registry duplicates endpoint knowledge on purpose: that duplication IS the curation layer (names, descriptions, guidance), and the parity CI keeps it honest.
