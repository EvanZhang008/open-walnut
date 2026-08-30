# Provider Live Matrix

One generic scenario set, every coding-agent provider. Real binaries, real turns, an isolated ephemeral server per run — zero mocks. Born from the 2026-08-12 codex stress run (14 ad-hoc scenarios, 3 real bugs); this folder makes that coverage permanent and provider-agnostic.

## Run

```bash
# Codex (needs a logged-in system codex + built dist/daemon-binaries)
WALNUT_LIVE_CODEX=1 npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts

# Claude Code (needs claude CLI on PATH)
WALNUT_LIVE_CLAUDE=1 npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts

# The other ACP CLIs (each needs its own binary on PATH + built dist/daemon-binaries)
WALNUT_LIVE_GEMINI=1   npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts
WALNUT_LIVE_OPENCODE=1 npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts
WALNUT_LIVE_GOOSE=1    npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts

# Any combination in one run
WALNUT_LIVE_CODEX=1 WALNUT_LIVE_CLAUDE=1 npx vitest run --config vitest.live.config.ts tests/live/provider-matrix/matrix.live.test.ts
```

Ungated or unavailable providers skip loudly (reason printed), never silently.

## Registered providers

| Provider | `engine` | Gate env | Availability probe | Scenarios it runs |
|---|---|---|---|---|
| Codex (ACP) | `codex` | `WALNUT_LIVE_CODEX` | system codex binary + acp-worker bundle + codex-acp adapter | M1-M13 |
| Claude Code (native) | `claude` | `WALNUT_LIVE_CLAUDE` | `claude --version` | M1-M6, M11, M12 |
| Gemini (ACP) | `gemini` | `WALNUT_LIVE_GEMINI` | `gemini --version` (or `WALNUT_GEMINI_PATH`) + acp-worker bundle | M1-M5, M12 |
| OpenCode (ACP) | `opencode` | `WALNUT_LIVE_OPENCODE` | `opencode --version` (or `WALNUT_OPENCODE_PATH`) + acp-worker bundle | M1-M5, M12 |
| Goose (ACP) | `goose` | `WALNUT_LIVE_GOOSE` | `goose --version` (or `WALNUT_GOOSE_PATH`) + acp-worker bundle | M1-M5, M12 |

The three newest ACP CLIs start deliberately narrow: their permission asks are not mapped onto Walnut's provider-neutral `pendingPermissions` shape yet and their model/mode controls are unverified, so the specs declare only what is proven and the matrix skips the rest. Widen a spec (add `permissions.canTriggerAsk`, `models.switchable`, `raceControl`, `crashRecovery`, `steering`) as each axis is confirmed against the real binary. `custom` has no spec: its adapter argv comes from user config, so there is no binary a CI machine could probe.

First run of a new gate, what to watch: M3, M4 and M5 drive a long shell command (`sleep 20 && echo …`). An engine that asks for approval before running it, and whose asks Walnut does not yet surface as `pendingPermissions`, will sit on that turn until the scenario's budget expires. If that happens, configure the CLI's own auto-approve/yolo default in its config file before blaming the matrix, and record the working control in the spec's `permissions.autoApprove` so the M9 scenario turns on too.

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
