---
name: test-and-verify-walnut
description: "E2E verification for Walnut features — design real user-workflow tests, execute via Playwright + API + unit tests, and report results. Always reads walnut-console-ops first."
requires:
  bins: []
---

# /verify — Walnut End-to-End Verification

**FIRST ACTION**: Read `walnut-console-ops` skill (`.claude/skills/walnut-console-ops/SKILL.md` relative to project root) for the UI layout and interaction patterns. Every verification session needs this context.

## The Core Problem This Skill Solves

Generic verification ("load the page, see it works") is useless. Real verification exercises the **actual user workflow end-to-end**. For every feature, ask: "If I were the user, what would I do? What would I see? What could go wrong?"

## Phase 0: Classify the Change

Before designing tests, classify what changed:

| Change Type | Primary Test Method | Example |
|---|---|---|
| **Frontend-only** (component, CSS, layout) | Playwright UI interaction | Task pill styling, panel toggle |
| **Backend-only** (API, session, provider) | API calls + unit tests + server logs | SCP transfer, session resume |
| **Full-stack** (new feature visible in UI) | Chat workflow → observe UI + API | New tool, session mode, triage |
| **Bug fix** | Reproduce bug first → fix → verify gone | Status not updating, missing data |

**Critical insight**: If the feature is backend-only, don't waste time taking screenshots of the homepage. Instead, test the actual backend behavior through API calls, server logs, or integration tests.

## Phase 1: Design Real User Workflows (THINK HARD)

For each change, trace the **complete user journey**:

### Template: How Would a User Exercise This Feature?

```
1. USER does X (types in chat, clicks button, attaches image...)
2. SYSTEM does Y internally (API call, session spawn, SCP transfer...)
3. USER sees Z in the UI (status change, session output, error message...)
4. USER can VERIFY by doing W (clicking session, reading output, checking file...)
```

### Design 2-5 Scenarios Per Feature

For every scenario, define:
- **Trigger**: What user action starts the workflow?
- **Observable effect**: What should the user see/verify?
- **Verification method**: How do we confirm it worked?
  - UI check (Playwright screenshot + DOM snapshot)
  - API check (`curl` endpoint, check response)
  - Log check (grep server logs for expected entries)
  - File check (verify file exists, content correct)
  - Session output check (session history contains expected content)

### Example: SCP Image Transfer Feature

**BAD test design** (what NOT to do):
```
1. Navigate to homepage → screenshot → "PASS" (proves nothing)
2. Navigate to sessions page → screenshot → "PASS" (still proves nothing)
```

**GOOD test design**:
```
Scenario 1: Happy Path — Image transferred to remote session
  Trigger: Chat with main agent: "Start a session on remote-host to analyze /path/to/image.png"
  Verify:
    - Server log shows "image transfer: transferred and rewrote paths"
    - Session prompt contains /tmp/walnut-images/{hash}/image.png (not local path)

Scenario 2: No images — Zero overhead
  Trigger: Start remote session with text-only prompt (no image paths)
  Verify:
    - Server log does NOT show "image transfer" entries
    - Session starts normally

Scenario 3: SCP failure — Graceful degradation
  Trigger: Start remote session with image, but mock SCP failure
  Verify:
    - Server log shows warning "scp failed — proceeding without images"
    - Session still starts (not blocked)
    - Prompt still contains original local path (not rewritten)

Scenario 4: Unit test confirmation
  Trigger: Run npx vitest tests/providers/session-io*.test.ts
  Verify: All N tests pass
```

## Phase 2: Build

```bash
npm run build                    # server TypeScript
cd web && npx vite build         # React SPA (only if frontend changed)
```

Report build status. If either fails, stop and show the error.

## Phase 3: Execute Tests

### Test Method 1: Unit Tests (fastest, most reliable)

```bash
npx vitest run tests/path/to/relevant.test.ts
```

**When to use**: Always. Unit tests are the foundation. Run them first.

### Test Method 2: API Tests (backend behavior without UI)

Use an **ephemeral server** to avoid polluting production:

```bash
result=$(walnut web --ephemeral)
port=$(echo "$result" | jq -r .port)
pid=$(echo "$result" | jq -r .pid)

# Test API endpoints
curl -s http://localhost:$port/api/sessions | jq 'length'
curl -s -X POST http://localhost:$port/api/tasks -H 'Content-Type: application/json' \
  -d '{"title":"Test task","category":"Test","project":"Test"}'

# When done
kill $pid
```

**When to use**: Backend features, API changes, data model changes.

### Test Method 3: Server Log Verification

For features that don't have UI output but produce server logs:

```bash
# Check recent server logs for expected entries
tail -100 /tmp/walnut/walnut-$(date +%Y-%m-%d).log | grep "image transfer"
```

**When to use**: Background processes, hooks, transfers, cleanup operations.

### Test Method 4: Chat Workflow (full-stack via main agent)

Talk to the main agent through the chat input to trigger the feature:

1. Navigate to `http://localhost:3456`
2. Read `walnut-console-ops` to understand input boxes
3. Type in the **main chat input** (placeholder: "Type a message...")
4. Wait for agent response (Act → Wait 10-30s → Screenshot → Snapshot)
5. If agent creates a session, click the session link to open SessionPanel
6. Verify session status, output, work_status in **three places**:
   - SessionPanel header
   - TodoPanel SessionPill
   - TodoDetailPanel sessions list

**When to use**: Full-stack features, session-related changes, agent tool changes.

### Test Method 5: Playwright UI Verification

Use Playwright MCP tools for pure frontend verification:

```
1. browser_navigate to http://localhost:3456
2. browser_snapshot — get clickable refs
3. browser_click — interact with UI elements
4. browser_take_screenshot — capture visual state
5. browser_snapshot — verify DOM attributes
```

**Key rules from walnut-console-ops**:
- **Stay on `/`** — panels open inline, don't navigate to separate pages
- **Disambiguate inputs by placeholder** — multiple input boxes coexist
- **Act → Wait → Verify** — every action triggers async work
- **Screenshot is ground truth** — when DOM and visual disagree, trust screenshot
- **Refs are ephemeral** — re-snapshot before interacting after any change

**When to use**: Frontend changes, layout changes, visual bugs, state persistence.

### Test Method 6: Console-Driven Full E2E (the gold standard)

**This is the highest-fidelity test.** You operate the Walnut console exactly as a human would — talk to the main agent, let it create tasks and sessions, then verify the outcome through the UI and the real infrastructure. No API shortcuts, no mocks.

**When to use**: Any feature that touches the session pipeline, agent tools, or cross-machine behavior. This is mandatory for features involving remote sessions, image handling, or agent-orchestrated workflows.

**How it works**:

1. **Prepare test data** — create any files, images, or state the feature needs
   ```bash
   # Example: create a test image for SCP transfer verification
   echo "test-data" > ~/.walnut/images/verify-test.png
   ```

2. **Talk to the main agent via console chat** — use the main chat input (placeholder: "Type a message...") to ask the agent to exercise the feature. Be explicit about what you want:
   > "Create a task 'Verify SCP Transfer' in Projects/Walnut. Start a bypass session on remote-host. In the session prompt, include a reference to the image ~/.walnut/images/verify-test.png and ask the session to confirm what path it sees for that file."

3. **Wait for the agent to respond** — the agent will create the task, start the session, and reply with a session link. Screenshot the response.

4. **Click the session link** — SessionPanel opens inline on the same page. Screenshot to confirm it's running.

5. **Verify in the SessionPanel** — read the session's conversation. Check that:
   - The prompt the session received has the **rewritten path** (e.g., `/tmp/walnut-images/{hash}/verify-test.png`) not the original local path
   - The session is actually running on the remote host

6. **Verify on the remote machine** — SSH to confirm the file actually arrived:
   ```bash
   ssh remote-host "ls -la /tmp/walnut-images/*/verify-test.png"
   ```

7. **Verify server logs** — confirm the transfer was logged:
   ```bash
   grep "image transfer" /tmp/walnut/walnut-$(date +%Y-%m-%d).log | tail -5
   ```

8. **Clean up** — stop the test session, delete the test task if desired.

**Key principles**:
- **You are the user** — interact through the console, not through direct API calls
- **The main agent is the orchestrator** — let it create tasks and sessions for you
- **Verify at every layer**: UI (screenshot) → server logs → remote machine state
- **Screenshot every step** — evidence chain from trigger to outcome
- **If the session can't read the file, the feature is broken** — that's the ultimate litmus test

## Phase 4: Report

Use the same narrative format as `/verify`:

```markdown
## Verification Report: <Feature/Fix Name>

### Build
- **Server build**: PASS/FAIL
- **Frontend build**: PASS/FAIL (or "N/A — no frontend changes")

---

### Scenario 1: <Name>

**Goal**: <what this validates from user perspective>
**Test method**: <unit test / API / log check / chat workflow / Playwright>

#### Step 1 — <Action>
- **Action**: <what was done>
- **Expected**: <what should happen>
- **Actual**: <what happened — quote logs, API responses, DOM content>
- **Result**: PASS/FAIL
- **Evidence**: <screenshot path, log excerpt, test output, API response>

**Scenario Result**: PASS/FAIL

---

### Overall Summary
- **Scenarios**: N passed / M total
- **Test methods used**: unit tests, API, logs, Playwright
- **Blocking issues**: <list or "none">
- **Manual verification needed**: <list items that can't be auto-tested>
- **Overall**: PASS/FAIL
```

## Decision Guide: What Tests For What Feature?

```
Feature involves... → Test with...
─────────────────────────────────────────────────
New UI component     → Playwright (render, click, state)
API endpoint change  → curl ephemeral + unit tests
Session behavior     → Console E2E + server logs + unit tests
Background process   → Server logs + unit tests
Data model change    → API test + unit tests
SSH/remote feature   → Console E2E (talk to agent → start remote session → verify remote) + unit tests
Agent tool change    → Console E2E (ask agent to use the tool → verify outcome)
Bug fix              → Reproduce via console → fix → re-verify same way
```

**Rule of thumb**: If a human would trigger this feature by talking to Walnut in the console, your test should do the same.

## Anti-Patterns (DO NOT)

1. **"Homepage loads, PASS"** — Loading the homepage proves nothing about your feature
2. **Skipping unit tests** — They're the fastest, most reliable verification
3. **Playwright for backend features** — If nothing changed in the UI, don't test the UI
4. **Not checking server logs** — Many features only manifest in logs, not UI
5. **Not using ephemeral server** — Testing against production risks side effects
6. **Testing with `page.goto()` for SPA nav** — Use sidebar clicks, button clicks
7. **Not designing scenarios first** — If you can't describe what to test, you can't test it
