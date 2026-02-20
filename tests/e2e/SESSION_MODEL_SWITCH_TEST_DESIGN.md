# Session Model Switch — E2E Test Design

Covers two test suites: backend (vitest + real server + WebSocket + mock CLI) and browser (Playwright).

---

## Suite 1: Backend E2E — `tests/e2e/session-model-switch.test.ts`

### Pattern

Same as `session-mode-change.test.ts`:
- `vi.mock('../../src/constants.js', () => createMockConstants())`
- Real Express server via `startServer({ port: 0, dev: true })`
- WebSocket client (`ws` package)
- Mock CLI (`tests/providers/mock-claude.mjs`) via `sessionRunner.setCliCommand(MOCK_CLI)`
- Seed `tasks.json` with dedicated test tasks (unique IDs per test)

### Setup / Teardown

```
beforeAll:
  1. Create temp WALNUT_HOME via createMockConstants()
  2. sessionRunner.setCliCommand(MOCK_CLI)
  3. Seed tasks.json with 5 tasks: model-switch-task-{001..005}
     Each task: { id, title, status: 'todo', priority: 'immediate',
                  category: 'Work', project: 'Walnut', session_ids: [],
                  source: 'ms-todo', ... }
  4. startServer({ port: 0, dev: true }) → capture port

afterAll:
  1. stopServer()
  2. rm -rf WALNUT_HOME
```

### Shared Helpers

Reuse the exact helpers from `session-mode-change.test.ts`:

| Helper | Signature | Purpose |
|--------|-----------|---------|
| `connectWs()` | `() => Promise<WebSocket>` | Connect to `ws://localhost:${port}/ws` |
| `waitForWsEvent()` | `(ws, eventName, predicate?, timeout?) => Promise<WsEvent>` | Wait for a specific bus event over WS |
| `collectWsEvents()` | `(ws, eventNames[]) => WsEvent[]` | Accumulate events into an array for later assertions |
| `sendWsRpc()` | `(ws, method, payload) => Promise<WsEvent>` | Send an RPC and await the response frame |
| `delay()` | `(ms) => Promise<void>` | Simple timer |

### Test 1: Deferred model switch — follow-up with `model: 'sonnet'`

**What it proves**: After a session completes its first turn, sending a follow-up with `model: 'sonnet'` causes the next `--resume` to pass `--model sonnet` to the CLI, and the result text contains `[model:sonnet]`.

**Setup**: None beyond shared setup.

**Steps**:
1. `ws = await connectWs()`
2. Start a session:
   ```
   sendWsRpc(ws, 'session:start', {
     taskId: 'model-switch-task-001',
     message: 'initial turn, no model switch',
     project: 'Walnut',
     mode: 'bypass',
   })
   ```
3. Wait for `session:result` event (first turn completes).
4. Extract `sessionId` from result event data.
5. Send follow-up with model switch:
   ```
   sendWsRpc(ws, 'session:send', {
     sessionId,
     message: 'follow-up after model switch',
     model: 'sonnet',
   })
   ```
6. Wait for second `session:result` event for this session.
7. Extract result text from event data.

**Assertions**:
- First result text does NOT contain `[model:sonnet]` (no model flag on initial turn).
- Second result text contains `[model:sonnet]` — proves `--model sonnet` was passed to CLI.
- Second result text contains the follow-up message text.

**Cleanup**: `ws.close()`

---

### Test 2: Immediate model switch (interrupt) — `model: 'haiku', interrupt: true`

**What it proves**: Sending `{ model: 'haiku', interrupt: true }` on an actively processing session interrupts the current turn and spawns a new `--resume` with `--model haiku`.

**Setup**: None beyond shared setup.

**Steps**:
1. `ws = await connectWs()`
2. Start a SLOW session (gives time to interrupt):
   ```
   sendWsRpc(ws, 'session:start', {
     taskId: 'model-switch-task-002',
     message: 'slow:3000 long running task',
     project: 'Walnut',
     mode: 'bypass',
   })
   ```
3. Wait for `session:started` event (session is running, not yet complete).
4. Extract `sessionId`.
5. Wait a short delay (500ms) so the session is mid-processing.
6. Send interrupt + model switch:
   ```
   sendWsRpc(ws, 'session:send', {
     sessionId,
     message: 'interrupt and switch model',
     model: 'haiku',
     interrupt: true,
   })
   ```
7. Collect all `session:result` events for this session. Wait up to 15s.

**Assertions**:
- At least one result event arrives with text containing `[model:haiku]`.
- The result text for the haiku turn contains the interrupt message text.
- The session completed (got a `session:result`).

**Cleanup**: `ws.close()`

---

### Test 3: Model persists in session record — verify via REST

**What it proves**: After a model switch completes, the session record is accessible via REST and the session finished successfully.

**Setup**: None beyond shared setup.

**Steps**:
1. `ws = await connectWs()`
2. Start session:
   ```
   sendWsRpc(ws, 'session:start', {
     taskId: 'model-switch-task-003',
     message: 'initial turn',
     project: 'Walnut',
     mode: 'bypass',
   })
   ```
3. Wait for first `session:result` → extract `sessionId`.
4. Send follow-up with model switch:
   ```
   sendWsRpc(ws, 'session:send', {
     sessionId,
     message: 'model switch to sonnet',
     model: 'sonnet',
   })
   ```
5. Wait for second `session:result`.
6. `await delay(500)` — let async record updates settle.
7. Fetch session via REST: `GET /api/sessions/${sessionId}`.

**Assertions**:
- REST response status is 200.
- Session record exists and has a valid `claudeSessionId`.
- Session `work_status` is a terminal status (e.g., `'agent_complete'` or `'completed'`).
- `pendingModel` is `undefined` (cleared after consumption by processNext).

**Cleanup**: `ws.close()`

---

### Test 4: pendingModel cleared after consumption — no stale model on next send

**What it proves**: After a model switch is consumed by `processNext()`, subsequent sends without a `model` field do NOT re-apply the old model. The mock CLI should produce a result without `[model:sonnet]` (it only echoes the flag if `--model` is passed).

**Setup**: None beyond shared setup.

**Steps**:
1. `ws = await connectWs()`
2. Start session:
   ```
   sendWsRpc(ws, 'session:start', {
     taskId: 'model-switch-task-004',
     message: 'initial turn',
     project: 'Walnut',
     mode: 'bypass',
   })
   ```
3. Wait for first `session:result` → extract `sessionId`.
4. Send with model switch:
   ```
   sendWsRpc(ws, 'session:send', {
     sessionId,
     message: 'switch to sonnet',
     model: 'sonnet',
   })
   ```
5. Wait for second `session:result` → verify `[model:sonnet]` in text.
6. Send ANOTHER follow-up WITHOUT model field:
   ```
   sendWsRpc(ws, 'session:send', {
     sessionId,
     message: 'no model override this time',
   })
   ```
7. Wait for third `session:result`.

**Assertions**:
- Second result text contains `[model:sonnet]`.
- Third result text does NOT contain `[model:sonnet]` and does NOT contain `[model:haiku]` — no stale model re-applied.
- Third result text contains the third message text (proves it processed).

**Cleanup**: `ws.close()`

---

### Test 5: Empty message model switch — `{ message: '', model: 'sonnet' }`

**What it proves**: A model switch can be sent with an empty message (the UI sends this pattern). The backend still triggers `--resume` with the new model.

**Setup**: None beyond shared setup.

**Steps**:
1. `ws = await connectWs()`
2. Start session:
   ```
   sendWsRpc(ws, 'session:start', {
     taskId: 'model-switch-task-005',
     message: 'initial turn before empty model switch',
     project: 'Walnut',
     mode: 'bypass',
   })
   ```
3. Wait for first `session:result` → extract `sessionId`.
4. Send empty message with model:
   ```
   sendWsRpc(ws, 'session:send', {
     sessionId,
     message: '',
     model: 'sonnet',
   })
   ```
5. Wait for second `session:result`.

**Assertions**:
- Second result arrives (session didn't stall on empty message).
- Second result text contains `[model:sonnet]`.

**Cleanup**: `ws.close()`

---

## Suite 2: Playwright Browser — `tests/e2e/browser/model-switch.spec.ts`

### Pattern

Same as `session-mode-pill.spec.ts` and `app.spec.ts`:
- Runs against the Playwright test server on port 3457 (`tests/e2e/browser/test-server.ts`)
- Uses pre-built SPA (requires `cd web && npx vite build` beforehand)
- Injects WS events via captured WebSocket (same `addInitScript` pattern as `session-mode-pill.spec.ts`)

### Seed Data Required

Add to `test-server.ts` tasks:
```ts
{
  id: 'pw-task-model-switch',
  title: 'Model switch test task',
  status: 'in_progress',
  phase: 'IN_PROGRESS',
  priority: 'immediate',
  category: 'Work',
  project: 'Walnut',
  source: 'ms-todo',
  session_id: 'pw-model-switch-session',
  session_status: { work_status: 'in_progress', process_status: 'running', mode: 'bypass' },
  session_ids: ['pw-model-switch-session'],
  active_session_ids: ['pw-model-switch-session'],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  description: '',
  summary: '',
  note: '',
  subtasks: [],
}
```

Add to `test-server.ts` sessions:
```ts
{
  claudeSessionId: 'pw-model-switch-session',
  taskId: 'pw-task-model-switch',
  project: 'Walnut',
  process_status: 'running',
  work_status: 'in_progress',
  mode: 'bypass',
  last_status_change: new Date().toISOString(),
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  lastActiveAt: new Date().toISOString(),
  messageCount: 1,
  cwd: process.cwd(),
  title: 'Bypass: model switch test',
}
```

### beforeEach hook

Same WebSocket capture as `session-mode-pill.spec.ts`:
```ts
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        if (!(window).__capturedWs) {
          (window).__capturedWs = this;
        }
      }
    };
    // ... copy static properties
  });
});
```

Shared `injectEvent()` helper (same as `session-mode-pill.spec.ts`):
```ts
async function injectEvent(page, name, data) {
  await page.evaluate(({ name, data }) => {
    const ws = window.__capturedWs;
    if (!ws) throw new Error('No captured WebSocket');
    const frame = JSON.stringify({ type: 'event', name, data, seq: Date.now() });
    ws.dispatchEvent(new MessageEvent('message', { data: frame }));
  }, { name, data });
}
```

---

### Test 1: ModelPicker opens via `/model` command

**What it proves**: Typing `/m` in the session chat input shows the command palette with `/model` listed, and selecting it opens the ModelPicker drawer.

**Steps**:
1. Navigate to sessions page: `page.goto('/sessions')` and `waitForLoadState('networkidle')`.
2. Find the session for `pw-task-model-switch` in the session list, click to open it.
   - Locator: `page.locator('.session-list-item', { hasText: 'Model switch test task' })` or similar — adapt to actual DOM structure.
   - Alternative: navigate directly if sessions page auto-shows the active session.
3. Find the chat input: `page.locator('.chat-input-textarea')` (in session panel).
4. Type `/m` in the input.
5. Wait for command palette to appear: `page.locator('.command-palette')` should be visible.
6. Check palette contains `/model` entry with text "Switch model (opus / sonnet / haiku)".

**Assertions**:
- Command palette is visible after typing `/m`.
- Palette contains an item with text "model" and description mentioning "opus / sonnet / haiku".
- The `/model` item has the "Control" badge: verify `.command-palette-source-control` class is present on the source badge element within that palette item.
- Click the `/model` palette item.
- After clicking, the `.model-picker` element should be visible in the DOM.

**Cleanup**: None needed (state resets per-test).

---

### Test 2: Model cards render correctly

**What it proves**: The ModelPicker shows 3 model options (Opus, Sonnet, Haiku) with correct labels, descriptions, and the current model highlighted.

**Precondition**: ModelPicker is open (reuse test 1's flow or inject state).

**Steps**:
1. Navigate to sessions page, open the active session.
2. Open the ModelPicker (type `/m`, select `/model` from palette).
3. Wait for `.model-picker` to be visible.
4. Count `.model-picker-option` elements.
5. Check each option's label and description text.
6. Check which option has `.model-picker-option-active` class.

**Assertions**:
- Exactly 3 `.model-picker-option` elements.
- Option labels are "Opus", "Sonnet", "Haiku" (check `.model-picker-option-name` text).
- Descriptions are "Most capable", "Balanced", "Fastest" (check `.model-picker-option-desc` text).
- The active option (with `.model-picker-option-active`) matches the current session model. Since the seed session has no explicit model (defaults to opus), the "Opus" card should be active.
- Active card shows "Active" badge (`.model-picker-option-badge`).
- Non-active cards show "Next turn" and "Now" buttons.

---

### Test 3: Selecting model closes picker

**What it proves**: Clicking a "Next turn" button on a non-active model card closes the ModelPicker.

**Steps**:
1. Navigate to sessions page, open the active session.
2. Open ModelPicker via `/model` command.
3. Wait for `.model-picker` to be visible.
4. Find the "Sonnet" option (not active): `page.locator('.model-picker-option', { hasText: 'Sonnet' })`.
5. Click the "Next turn" button within that option: `.model-picker-btn`.
6. Wait for `.model-picker` to become hidden.

**Assertions**:
- After clicking "Next turn", `.model-picker` is no longer visible (timeout 3s).
- The input is cleared / returned to normal state (no `/model` text lingering).

---

### Test 4: Control badge styling

**What it proves**: The `/model` command in the palette has distinct "Control" badge styling, differentiating it from regular session slash commands.

**Steps**:
1. Navigate to sessions page, open the active session.
2. Type `/m` in the chat input.
3. Wait for command palette.
4. Find the `/model` palette item.
5. Check the source badge element within that item.

**Assertions**:
- The palette item for "model" has a child element with class `.command-palette-source-control`.
- The badge text is "Control" (not "Session" or "Agent").
- Optionally verify the amber color styling is applied (check computed backgroundColor or the CSS class).

---

## Implementation Notes for Test Agents

### Backend suite (`session-model-switch.test.ts`)

- File location: `tests/e2e/session-model-switch.test.ts`
- Import pattern: identical to `session-mode-change.test.ts` (copy the import block and helpers verbatim)
- The mock CLI at `tests/providers/mock-claude.mjs` already handles `--model` flag: it echoes `[model:<flag>]` in the result text and sets `model` in the init event. No changes needed.
- Each test needs its own task ID to avoid cross-test interference (tasks are shared state).
- Use `waitForWsEvent(ws, 'session:result', pred)` with a predicate matching the expected sessionId to avoid capturing results from other tests (tests run in the same `describe` block sequentially, but events may overlap).
- For Test 2 (interrupt): `slow:3000` prefix makes the mock CLI delay 3 seconds between init and result events, giving a window for the interrupt.
- For Test 4 (pending cleared): three sequential send/wait cycles — test must be patient with timeouts (use 15s per wait).
- For Test 5 (empty message): the message queue may skip empty strings — check that `enqueueMessage()` handles `''`. If it does, the test works as designed. If not, the backend may need a fix to enqueue a synthetic message for model-only switches. The test will expose this.

### Browser suite (`model-switch.spec.ts`)

- File location: `tests/e2e/browser/model-switch.spec.ts`
- Requires seed data in `test-server.ts` (task + session records as specified above).
- The sessions page DOM structure needs exploration — the test agent should inspect the actual rendered DOM to find correct locators. Key areas:
  - Session list / session tree on the left panel
  - Session detail / chat panel on the right
  - Chat input at the bottom of the session detail panel
  - Command palette dropdown
- The ModelPicker renders inside `SessionPanel.tsx` when `modelPickerOpen` state is true.
- WebSocket capture (`__capturedWs`) may not be needed for these tests since they don't inject events — they test real UI interactions. However, the test server doesn't run a real CLI, so session interactions won't produce real results. The tests focus on UI rendering and command flow, not actual model switching.
- If the sessions page requires a running session to show the chat input, the seed data must have `process_status: 'running'` and `work_status: 'in_progress'`.
