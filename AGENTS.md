# AGENTS.md — Walnut Development Guide

## Testing Requirements

Every code change MUST include tests. No exceptions. Tests are not an afterthought — they are part of the feature.

### Test Philosophy

**Think before you write.** A bad test is worse than no test — it gives false confidence. Before writing any test:

1. **Trace the data flow.** For the feature you're testing, draw the path: User action → API → Core → Side effects → Event Bus → WS → UI. Each hop is a potential failure point.

2. **Identify what can break.** Don't test that `1 + 1 === 2`. Test the seams: what happens when the file doesn't exist? When the ID is ambiguous? When two clients are connected? When the input has `" / "` in it?

3. **Test behavior, not implementation.** Don't assert on internal state. Assert on observable outcomes: HTTP responses, WS events received, data persisted to disk.

### The Pyramid: What to Write

```
                    ┌──────────┐
                    │Playwright│  Tier 4: Real browser (visual, clicks, real-time)
                   ┌┴──────────┴┐
                   │   E2E       │  Tier 3: Real server + WS (full pipeline)
                  ┌┴─────────────┴┐
                  │  Integration   │  Tier 2: Supertest routes (HTTP contracts)
                 ┌┴────────────────┴┐
                 │     Unit          │  Tier 1: Isolated functions (logic, edge cases)
                 └───────────────────┘
```

**The rule: every feature needs at least 1 real E2E test.** Unit tests are for edge cases. The happy path MUST be tested with a real server, real HTTP, and real WebSocket.

### Tier 1 — Unit Tests (`tests/core/`, `tests/agent/`)

Isolated functions with mocked file paths (temp directory). Tests go here when you're testing:
- Core logic (task state transitions, memory writes, search indexing)
- Parsing and formatting (slash format, ID generation)
- Edge cases (empty input, ambiguous prefix, concurrent writes)

```bash
npx vitest run tests/core/my-feature.test.ts
```

### Tier 2 — Integration Tests (`tests/web/routes/`)

API routes tested via supertest (in-process Express, no real server). Tests go here for:
- HTTP status codes and response shapes
- Request validation (missing fields, bad params, URL encoding)
- Route registration (new endpoints actually respond)

```bash
npx vitest run tests/web/routes/my-feature.test.ts
```

### Tier 3 — E2E Tests (`tests/e2e/`)

Real server on random port + WebSocket clients. This is the **most important tier**. Tests go here for:
- Full data pipeline: REST → Core → Event Bus → WS broadcast → correct payload
- State persistence: POST then GET to verify
- Multi-client scenarios: 2+ WS clients both receive the same event
- Cross-feature interactions: one feature's output is another's input

```bash
npx vitest run --config vitest.e2e.config.ts tests/e2e/my-feature.test.ts
```

**E2E test template**: see `.claude/commands/test.md` for the full boilerplate.

### Tier 4 — Playwright Browser Tests

Use the Playwright MCP tools to test the actual UI in a real browser. Do this AFTER all server-side tests pass.

**When to use Playwright:**
- A feature changes what the user sees (new tab, new button, layout change)
- A feature involves real-time updates (WS event → UI re-render)
- A feature has interactive elements (click handlers, form submission)

**How to run Playwright tests:**

1. Start the dev server in the background:
```bash
walnut web --port 3457 &
```

2. Use Playwright MCP tools:
```
mcp__playwright__browser_navigate → http://localhost:3457
mcp__playwright__browser_snapshot → read the page structure
mcp__playwright__browser_click   → interact with elements
mcp__playwright__browser_take_screenshot → capture visual state
```

3. Verify:
- Elements render correctly (tabs, buttons, lists)
- Click interactions work (checkbox toggles, star buttons)
- Real-time updates appear (create task via API, verify it appears in UI)

4. Kill the server when done.

**Playwright checklist for UI features:**
- [ ] Page loads without errors
- [ ] New UI elements are visible
- [ ] Click interactions produce expected state changes
- [ ] Screenshot captured for visual verification

### What Makes a Good Test

**Good test:** Creates a task with `category: "idea / work idea"` via POST, then GETs it back and verifies `category === "idea"` and `project === "work idea"`. Connects a WS client and verifies the `task:created` event carries the parsed fields.

**Bad test:** Imports `parseGroupFromCategory`, calls it with `"idea / work idea"`, asserts the return value. (This tests the utility, not the feature. It doesn't verify the parsing is actually wired into `addTask`.)

**Good test:** Creates a task, toggles it complete via API, checks the response says `"done"`, connects a second WS client, toggles it back, verifies both clients get `task:updated` with `status: "todo"`.

**Bad test:** Calls `toggleComplete()` directly, asserts `task.status === 'done'`. (Doesn't test the route, doesn't test event emission, doesn't test multi-client delivery.)

### Test Quality Checklist

Before a feature is done, verify:

- [ ] **At least 1 E2E test** that exercises REST → Core → Bus → WebSocket
- [ ] **State persistence** — POST then GET to confirm data survived
- [ ] **Bidirectional operations** — if something can be toggled, test both directions
- [ ] **Error paths** — bad IDs, missing fields, ambiguous prefixes
- [ ] **Multi-client WS** — if events are emitted, verify 2 clients both receive them
- [ ] **Playwright screenshot** — if the feature has UI, capture it in a real browser
- [ ] **All tests pass** — `npm test && npm run test:e2e`

## Session Context Enrichment

When a session starts via `start_session`, `buildSessionContext(taskId)` in `src/agent/session-context.ts` assembles a bounded context block (~3000 tokens) from task metadata, subtasks, notes, prior session summaries, and project memory. This is passed to `claude -p` via `--append-system-prompt`. The triage agent also receives recent conversation history for better post-session processing. See `src/providers/claude-code-session.ts` (handleStart) and `src/web/server.ts` (triage handler).

## Logging

**Structured logging** — `src/logging/` provides subsystem-tagged loggers writing JSON lines to `/tmp/walnut/walnut-YYYY-MM-DD.log` and colored output to stderr. Import via `import { log } from '../logging/index.js'`. Use `log.bus`, `log.agent`, `log.session`, `log.web`, `log.ws`, `log.hook`, `log.task`, `log.memory`. View logs with `walnut logs [--follow] [--subsystem NAME]`. Sensitive data is auto-redacted. See `CLAUDE.md` "Logging & Debugging" for full details.

## Heartbeat System

**Periodic AI self-check** — the heartbeat wakes the agent at configurable intervals to read `~/.walnut/HEARTBEAT.md` and decide if anything needs the user's attention. Config lives under `config.heartbeat` (enabled, every, activeHours). Core runner in `src/heartbeat/`, REST routes at `/api/heartbeat` (status) and `/api/heartbeat/trigger` (manual). Runner uses recursive setTimeout (no overlap). If the AI replies `HEARTBEAT_OK`, the UI shows a compact "All clear" line; substantive responses render with a red accent border and `❤️ HEARTBEAT` label. All heartbeat messages (both OK and substantive) are visible in chat. Detection uses `isHeartbeatOk()` (line-based matching to avoid false positives). Tests: `tests/core/heartbeat.test.ts`. Logger: `log.heartbeat`.

## Plugin Sync Failure Handling

**Sync failures are surfaced, not silent.** `autoPushIfConfigured()` in `src/core/task-manager.ts` returns a `SyncResult` (success/failure) instead of swallowing errors. The `create_task` agent tool reports sync status in its response. Unsynced tasks (source set but no corresponding ext entry) are retried during the 60s periodic sync in `src/web/server.ts`. The UI shows orange warning badges for unsynced tasks in both `TaskCard` (`sync-unsynced` class) and `TodoPanel` (`task-source-badge-unsynced` class). API error response bodies are logged by each plugin's client module.

## Browser Automation

**Migrated to standalone skill.** Browser control has been extracted from Walnut into an independent Claude Code skill at `~/.claude/skills/browser-relay/`. The skill includes the relay server, CLI client, and Chrome extension — no browser code remains in Walnut. Any Claude Code session can use it via `npx tsx ~/.claude/skills/browser-relay/scripts/cli.ts <command>`.

## Stateful Agent Mode

**Persistent memory for embedded subagents.** Agents with a `stateful` config get project memory injected into their system prompt and can write back via `<memory_update>` tags. Memory is stored under `~/.walnut/memory/projects/{memory_project}/MEMORY.md`. The `SubagentRunner` handles injection pre-loop and persistence post-loop. Config fields: `memory_project` (required), `memory_budget_tokens` (default 4000), `memory_source`. Types in `src/core/types.ts` (`AgentStatefulConfig`), logic in `src/agent/stateful-memory.ts`. Agent registry auto-creates memory directories on create/update (`src/core/agent-registry.ts`).

## Cron Action System

**Lightweight registered functions for cron jobs.** New `action` payload kind runs a registered function inline (no agent loop), optionally piping the result to a target agent. Actions register via `registerAction(id, fn, description)` in `src/core/cron/actions.ts`. Execution flow: cron timer → `executeJobCore()` → `runAction()` → if `targetAgent` specified, `runActionWithAgent()` (supports multimodal messages for vision models). REST: `GET /api/cron/actions` lists registered actions. Types extended in `src/core/cron/types.ts`.

## Timeline / Life Tracker

**Screenshot-based activity tracker.** The `screenshot-track` action (`src/core/timeline/screenshot-action.ts`, macOS-only) captures screenshots via `screencapture`, creates 640px JPEG thumbnails, and uses file-size change detection to skip unchanged screens. Thumbnails stored at `~/.walnut/timeline/{date}/thumbnails/{timestamp}.jpg`. REST API at `src/web/routes/timeline.ts`: `GET /api/timeline?date=`, `GET /api/timeline/dates`, `GET /api/timeline/images/:date/:file`, `POST /api/timeline/toggle`. Frontend: `web/src/pages/TimelinePage.tsx` with date navigation, category bar chart, and activity list.

### Running All Tests

```bash
npm test                # Unit + Integration (parallel, ~5s)
npm run test:e2e        # E2E with real server (serial, ~15s)
npm run test:all        # Lint + Unit + Integration + E2E

# Single file
npx vitest run tests/core/my-feature.test.ts
npx vitest run --config vitest.e2e.config.ts tests/e2e/my-feature.test.ts
```
