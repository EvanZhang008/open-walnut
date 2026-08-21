# Provider Live Matrix

One generic scenario set, every coding-agent provider. Real binaries, real turns, an isolated ephemeral server per run — zero mocks. Born from the 2026-08-12 codex stress run (14 ad-hoc scenarios, 3 real bugs); this folder makes that coverage permanent and provider-agnostic.

## Run

```bash
# Codex (needs a logged-in system codex + built dist/daemon-binaries)
WALNUT_LIVE_CODEX=1 npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts

# Claude Code (needs claude CLI on PATH)
WALNUT_LIVE_CLAUDE=1 npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts

# Both in one run
WALNUT_LIVE_CODEX=1 WALNUT_LIVE_CLAUDE=1 npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts
```

Ungated or unavailable providers skip loudly (reason printed), never silently.

## Scenarios

| # | Scenario | Gate |
|---|---|---|
| M1 | Cold start answers a trivial prompt | always |
| M2 | Warm follow-up turn | always |
| M3 | Mid-turn message queues, drains after turn end | always |
| M4 | Flood: 5 rapid mid-turn sends, none lost | always |
| M5 | Interrupt long turn (REST + WS parity) | always |
| M6 | Model switch round-trip + verify turn | `models.switchable` |
| M7 | Permission ask → approve → runs | `permissions.canTriggerAsk` |
| M8 | Permission ask → deny → clean end | `permissions.canTriggerAsk` |
| M9 | Auto-approve mode: zero pending across multi-command turn | `permissions.autoApprove` |
| M10 | 10 parallel control toggles → deterministic, functional | `raceControl` |
| M11 | SIGKILL provider process mid-turn → resend recovers | `crashRecovery` |
| M12 | Force-delete task with live session → 204 | always |
| M13 | Mid-turn steering: send joins the LIVE turn (no queue wait) | `steering` |

## Adding a provider

1. Write `specs/<name>.ts` implementing `ProviderSpec` (see `provider-spec.ts` for field docs). Declare only the capabilities the provider has — the matrix skips the rest.
2. Register it in `specs/index.ts`.
3. Pick a gate env var (`WALNUT_LIVE_<NAME>`) and an `unavailableReason()` probe so CI machines without the binary skip cleanly.

That's the whole job. The matrix file never references concrete engines.

## Design notes

- **Ephemeral server, never prod :3456.** Worker kills and floods must not touch live sessions. The harness boots `dist/cli.js` on a random port with a temp `WALNUT_HOME` (build first: `npm run build`).
- **Session-id migration aware.** ACP sessions can mint a new provider session id across crash-resume; scenarios re-resolve the current sid via the task (`sidOf`) after any recovery.
- **Transcript assertions ride the history API** (`/history?source=streams`) — the same provider-neutral surface the UI uses, so a matrix pass means the UI story works too.
- **Capability gates over per-provider forks.** A provider without permission asks (or with a fixed model) passes by skipping those scenarios, not by faking them.
