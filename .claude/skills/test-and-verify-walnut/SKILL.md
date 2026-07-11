---
name: test-and-verify-walnut
description: "4-agent pipeline: design + implement code tests + Playwright UI tests + quality gate. Reads walnut-console-ops first."
---

# /test-and-verify-walnut

Every test must answer: **"If I reverted my code changes, would this test fail?"** NO → delete it.

**FIRST**: Read `.claude/skills/walnut-console-ops/SKILL.md` for UI layout and interaction patterns.

```
Main Agent (context) → Agent 1 (design) → Agent 2 (code) ∥ Agent 3 (Playwright) → Agent 4 (quality gate)
```

---

## Phase 0: Main Agent — Context

1. `git diff --stat HEAD~1` + `git log --oneline -5`
2. Read plan files: `.plan`, `~/.claude/plans/`, `.tasks/*/TASK.md`
3. Classify change type:

| Change Type | Primary Tests |
|---|---|
| Frontend-only | Playwright UI |
| Backend-only | API + unit + server logs |
| Full-stack | Console E2E + Playwright + unit |
| Bug fix | Reproduce → fix → re-verify |

4. Bundle context → pass to all agents.

---

## Phase 1: Agent 1 — Test Designer (read-only)

Design tests in 2 categories. Do NOT implement.

**Category A — UI (Playwright)**: 2-4 scenarios. For each: pre-conditions, steps (real clicks, NO `page.goto()` SPA nav), assertions (must include downstream verification — see below), screenshot points.

**Category B — Code (vitest)**: 2-4 tests, as E2E as possible. For each: name, tier, setup, exercise, assert (HTTP response + WS event + persisted data).

**Self-check each test**: "Would this pass with code reverted?" YES = delete.

**E2E means full consequence**: Every test must verify the **downstream effect** of the action, not just the immediate UI change. If the action triggers a backend round-trip, the test must wait for and verify the backend result.

Anti-patterns (test is SHALLOW or WORTHLESS if it only checks these):
- "page loads", "component renders", "no console errors"
- "API returns 200" without checking response body
- "clicked button and UI closed" without verifying the backend outcome
- "status badge changed" without verifying the underlying operation succeeded
- Testing mock config instead of production code

---

## Phase 2: Agent 2 — Code Test Writer (∥ Agent 3)

Implement Category B. Rules:
- Real server: `startServer({ port: 0, dev: true })`. Only mock Claude CLI (`tests/providers/mock-claude.mjs`).
- Assert on HTTP responses, WS events, file contents — not internal state.
- Place: `tests/e2e/` (pipeline), `tests/web/routes/` (API), `tests/core/` (logic), `tests/e2e/browser/` (Playwright code).
- Run and iterate until green.

---

## Phase 3: Agent 3 — Playwright Executor (∥ Agent 2)

**First**: Read `.claude/skills/walnut-console-ops/SKILL.md`.

Execute Category A:
- `mkdir -p /tmp/test-and-verify/`, build SPA: `cd web && npx vite build`
- Real UI clicks only. Screenshot every step to `/tmp/test-and-verify/<scenario>-step<N>.png`
- DOM snapshot before each action. Verify screenshots with `Read` tool.
- Act → Wait (5-20s) → Screenshot → Snapshot → verify.

**CRITICAL — Verify full consequence, not just UI reaction**:

Every UI action that triggers backend work must be verified **through to the downstream effect**. The test is NOT done when the UI element changes — it's done when the **outcome is confirmed**.

The question: **"Did the thing I triggered actually work?"** — not **"Did the UI react to my click?"**

**BAD (shallow)** — stops at UI reaction:
```
# Testing model switch:
Click "Opus 1M" → picker closes → screenshot → ✅ DONE
# WRONG: only proved the picker UI works. Did the session actually restart
# with the new model? Did the next message succeed? No idea.

# Testing task creation:
Click "Add" → task appears in list → screenshot → ✅ DONE
# WRONG: only proved the React component rendered. Did the task persist
# to disk? Can you reload and still see it? No idea.

# Testing session start:
Click "Start session" → status shows "Running" → screenshot → ✅ DONE
# WRONG: only proved the status badge updated. Did the session actually
# produce output? Did the CLI process spawn? No idea.
```

**GOOD (full consequence)** — verifies the downstream effect:
```
# Testing model switch:
Click "Opus 1M" → picker closes → send a message in session input →
wait for response → verify response text appears (no "API Error",
no "invalid model") → screenshot response → ✅ DONE

# Testing task creation:
Click "Add" → task appears in list → click the task → verify detail
panel shows correct title/category/project → ✅ DONE

# Testing session start:
Click "Start session" → status shows "Running" → wait for first
assistant message to appear in chat → verify message content →
screenshot → ✅ DONE
```

The pattern: **Action → UI reacts → wait for backend round-trip → verify outcome → screenshot proof**. If you stop at "UI reacts", the test is SHALLOW.

---

## Phase 4: Agent 4 — Quality Verifier (after 2+3)

For each test, ask TWO questions:
1. "Would this pass if feature was reverted?" YES = **WORTHLESS**, delete it.
2. "Does this verify the **downstream effect**, or just the immediate UI change?" UI-only = **SHALLOW**, must extend.

- **GENUINE**: Triggers action AND verifies the full backend/system consequence
- **SHALLOW**: Verifies UI reacted (button clicked, picker closed, badge changed) but NOT that the triggered operation succeeded. Must be extended to verify downstream.
- **WORTHLESS**: Would pass without code changes

A Playwright test that clicks a button and screenshots is **SHALLOW** unless it also waits for and verifies what that button *caused* (response arrived, status updated, data persisted, no errors).

Overall: PASS / NEEDS WORK / FAIL

---

## Phase 5: Report

```markdown
## Test & Verify Report: <Feature>
### Build — Server: PASS/FAIL, Frontend: PASS/FAIL
### Code Tests — <N> tests, <N> genuine
### UI Tests — <N> scenarios, <N> genuine
### Overall — PASS / NEEDS WORK / FAIL
```

## Phase 6: Learning Loop

New patterns → append to Learned Patterns below. Console-related → also update `walnut-console-ops/SKILL.md`.

---

## Test Reference

```bash
npm test                    # Unit + Integration (~5s)
npm run test:e2e            # E2E real server (~15s)
npm run test:all            # Everything
npx vitest run <file>       # Single test
cd web && npx vite build    # Build SPA before Playwright
npx playwright test         # Browser tests
```

**Pyramid**: Live → Playwright → **E2E** (most important) → Integration → Unit

**Mock only**: Claude CLI. Everything else real.

**Production safety**: `OPEN_WALNUT_HOME=/tmp/walnut-test-*/`. Never `~/.open-walnut/`. Port 3456 = production, never touch.

**Open source**: No internal tool names, employer references, or personal usernames.

### E2E Template
```typescript
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-FEATURE'));
import { startServer, stopServer } from '../../src/web/server.js';

let server, port;
beforeAll(async () => {
  server = await startServer({ port: 0, dev: true });
  port = (server.address() as any).port;
});
afterAll(() => stopServer());

it('REST → Core → Bus → WS', async () => {
  const ws = await connectWs();
  const event = waitForWsEvent(ws, 'task:created');
  const res = await fetch(`http://localhost:${port}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'test' }),
  });
  expect(res.status).toBe(201);
  expect((await event).data.task.title).toBe('test');
  ws.close();
});
```

### Session E2E: Mock CLI wrapper
```typescript
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs');
sessionRunner.setCliCommand(MOCK_WRAPPER); // before startServer
```

### Architecture (for test design)
- **Event Bus**: backbone — test WS delivery for entity CRUD
- **Phases**: TODO → IN_PROGRESS → AGENT_COMPLETE → AWAIT_HUMAN_ACTION → COMPLETE
- **Sessions**: 2-slot (plan + exec), PID monitoring, FIFO stall
- **Concurrency**: 2-layer locks. Test concurrent writes.
- **WS**: `{ type: 'event', name, data }` / RPC: `{ type: 'req', id, method, payload }`

### Gotchas
- WS events async — use `waitForWsEvent()` with timeout
- Build SPA before Playwright or you test stale HTML
- Click sidebar links, don't `page.goto('/route')` in SPA
- Concurrent tests need separate WALNUT_HOME dirs

---

## Learned Patterns

- **Real-session browser specs are now possible**: `tests/e2e/browser/test-server.ts` wires a
  MockDaemon + mock CLI (`sessionRunner.setCliCommand` + `setTestDaemonUrl`) into the Playwright
  server, so specs can create LIVE sessions via the `session:start` WS RPC and exercise the real
  event pipeline (no `__capturedWs` injection needed). Disable with `PW_NO_MOCK_DAEMON=1` when
  bisecting whether a failure comes from this wiring. See
  `tests/e2e/browser/single-timeline-real-pipeline.spec.ts` for the pattern (start session →
  poll `/api/sessions/task/:id` for the `mock-session-*` id → open `/sessions?id=`).
- **`chunk-delay:<ms>` mock-CLI prefix**: spaces out `content_block_delta` emissions in
  `stream-partial-thinking-then-text` so browser tests can observe partial text mid-turn
  (the default burst is synchronous and races any DOM poll). Composable: `chunk-delay:250
  stream-partial-thinking-then-text`.
- **MockDaemon JSONL is NOT where history REST reads**: the MockDaemon captures CLI output in its
  own tmpDir; `GET /:id/history` falls back to `SESSION_STREAMS_DIR/<sid>.jsonl`. Vitest tests
  that need real-parser history must copy `daemon.streamFilePath(sid)` →
  `SESSION_STREAMS_DIR` first (see `publishStreamsFile` in
  `tests/web/stream/single-timeline-real-pipeline.test.ts`). Symptom otherwise: history 200 with
  0 messages forever.
- **Full-suite failure triage**: `npx playwright test` failures may come from PARALLEL agents'
  uncommitted UI changes, not yours. Bisect by re-running the failing spec against the HEAD
  version of the shared harness file you touched (`git checkout <file>` → run → restore) before
  assuming a regression.
