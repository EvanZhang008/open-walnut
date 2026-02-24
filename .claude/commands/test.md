# /test — Create and Run Tests for a Feature

You are writing tests for Walnut. This command creates high-quality tests for a feature.

## Input

The user will describe what feature or code change needs testing. If no specific feature is given, look at recent git changes (`git diff --name-only`) and test those.

## Test Design Process

Before writing any test code, think through these questions:

### 1. What are the data flows?

Trace the feature's data path end-to-end:
```
User action → API route → Core function → Side effects (file writes, events) → WS broadcast → UI update
```

For each segment of this path, ask: "What can go wrong here? What assumptions does the code make?"

### 2. What are the boundary conditions?

- Empty inputs, missing fields, null/undefined
- First-time use (no data files exist yet)
- Duplicate operations (idempotent? error?)
- Partial ID matching (prefix match, ambiguous match, no match)
- URL-encoded special characters in params
- Concurrent operations

### 3. What are the state transitions?

- What states can the entity be in? (e.g., todo/done/in_progress)
- What transitions are valid? What happens on invalid transitions?
- Does state persist correctly after transition?
- Can the state be reversed? (e.g., done → todo)

### 4. What needs real E2E testing vs unit testing?

**Every feature MUST have at least 1 real E2E test** that:
- Starts a real server (`startServer({ port: 0, dev: true })`)
- Makes real HTTP requests (`fetch`)
- Connects real WebSocket clients (`new WebSocket`)
- Verifies the full pipeline: REST → Core → Event Bus → WebSocket

Mock tests are for edge cases and isolated logic. The happy path MUST be tested end-to-end.

## Test Tiers — What Goes Where

### Tier 1: Unit Tests (`tests/core/` or `tests/agent/`)

Test **isolated functions** with mocked file paths (tmpdir). Good for:
- Core business logic (addTask, toggleComplete, parseGroupFromCategory)
- State machines and transitions
- Edge cases and error handling
- Input validation and parsing

### Tier 2: Integration Tests (`tests/web/routes/`)

Test **API routes** with supertest (in-process Express, no real server). Good for:
- HTTP status codes and response shapes
- Request validation (missing fields, bad IDs)
- Route parameter parsing (URL encoding, path params)
- Response format contracts

### Tier 3: E2E Tests (`tests/e2e/`)

Test **the full data pipeline** with a real server + WebSocket. Good for:
- Complete user workflows (create → update → complete → verify)
- WebSocket event delivery (REST action → bus → WS broadcast → correct payload)
- Multi-client scenarios (2+ WS clients both receive events)
- State persistence across requests (POST then GET to verify)
- Cross-feature interactions (create with slash format → WS event has parsed fields)

### Tier 4: Playwright Browser Tests (`tests/e2e/browser/`)

Test **the actual UI** in a real browser with `@playwright/test`. Parallel workers (half CPUs locally, 4 in CI). Two modes:

**Automated code tests** (primary — `npx playwright test`):
- Tests live in `tests/e2e/browser/*.spec.ts`
- Config at `playwright.config.ts` auto-starts a test server
- Pre-requisite: build the SPA first (`cd web && npx vite build`)
- Use standard Playwright API: `page.goto()`, `page.locator()`, `expect()`
- Key selectors: `.todo-panel`, `.todo-panel-item`, `.task-checkbox`, `.chat-input-textarea`, `.page-title`, `input[aria-label="New task title"]`
- **Parallel safety**: each test creates unique data (`Date.now()` suffix) and asserts on that specific data

**Manual MCP verification** (final step after automated tests pass):
- Use Playwright MCP tools for visual spot-checks
- `mcp__playwright__browser_navigate`, `mcp__playwright__browser_snapshot`, `mcp__playwright__browser_click`, `mcp__playwright__browser_take_screenshot`

### Tier 5: Live Tests (`tests/**/*.live.test.ts`)

Test against **real external APIs** (Bedrock, MS To-Do). Expensive, opt-in only.

```typescript
import { isLiveTest, hasAwsCredentials } from '../helpers/live.js';

describe.skipIf(!isLiveTest() || !hasAwsCredentials())('Bedrock live', () => {
  it('sends a real prompt', async () => { /* ... */ });
});
```

- Use `isLiveTest()` guard — only runs when `WALNUT_LIVE_TEST=1`
- Use `hasAwsCredentials()` / `hasMsGraphCredentials()` to check for required credentials
- Serial execution (1 worker), 120s timeout
- Run with: `npm run test:live`

## Implementation Steps

1. **Read the code being tested** — understand the feature's implementation before writing tests
2. **Design test cases** — list what needs testing (happy path, edge cases, error paths)
3. **Write E2E test first** — start with the real pipeline test, then work backward to unit tests
4. **Write tests** following the patterns below
5. **Run the tests** and fix any failures
6. **Take a Playwright screenshot** of the feature if it has UI components

## File Patterns

### E2E Test Template (tests/e2e/)

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-FEATURE'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string) { return `http://localhost:${port}${p}`; }
function wsUrl() { return `ws://localhost:${port}/ws`; }

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
  });
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('Feature E2E', () => {
  it('full pipeline: REST action → WS event with correct payload', async () => {
    const ws = await connectWs();
    const eventPromise = waitForWsEvent(ws, 'task:created');

    const res = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'E2E test' }),
    });
    expect(res.status).toBe(201);

    const event = await eventPromise;
    expect((event.data as any).task.title).toBe('E2E test');

    ws.close();
    await delay(50);
  });
});
```

### Session E2E Test Pattern (tests/e2e/)

For tests involving Claude Code sessions, wire the mock CLI into the SessionRunner:

```typescript
import { sessionRunner } from '../../src/providers/claude-code-session.js';

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs');
const MOCK_WRAPPER = path.join(os.tmpdir(), `mock-claude-wrapper-${Date.now()}.sh`);

beforeAll(async () => {
  // Create shell wrapper for mock CLI
  await fs.writeFile(MOCK_WRAPPER, `#!/bin/bash\nexec node "${MOCK_CLI}" "$@"\n`, { mode: 0o755 });
  // Wire mock CLI into the singleton before server starts
  sessionRunner.setCliCommand(MOCK_WRAPPER);
  // ... start server ...
});
```

Use WS RPC to start sessions:
```typescript
function sendWsRpc(ws, method, payload) {
  const id = `rpc-${Date.now()}`;
  ws.send(JSON.stringify({ type: 'req', id, method, payload }));
  // Listen for { type: 'res', id, ok: true/false }
}
await sendWsRpc(ws, 'session:start', { taskId, message, project });
```

### Playwright Code Test Pattern (tests/e2e/browser/)

Automated `@playwright/test` specs — run with `npx playwright test`:

```typescript
import { test, expect } from '@playwright/test';

test('task appears in todo panel', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.todo-panel')).toContainText('My task');
});
```

Build SPA first: `cd web && npx vite build`

### Playwright MCP Manual Verification (final step)

After automated tests pass, use MCP tools for visual spot-checks:

```
1. mcp__playwright__browser_navigate → http://localhost:3457
2. mcp__playwright__browser_snapshot → verify DOM structure
3. mcp__playwright__browser_click → interact with elements
4. mcp__playwright__browser_take_screenshot → visual verification
```

## Running Tests

```bash
# Run specific test file
npx vitest run tests/e2e/my-feature.test.ts

# Run E2E tests (parallel, 4 workers)
npx vitest run --config vitest.e2e.config.ts tests/e2e/my-feature.test.ts

# Run Playwright browser tests (build SPA first!)
cd web && npx vite build && cd ..
npx playwright test

# Run a single Playwright spec
npx playwright test tests/e2e/browser/app.spec.ts

# Run live tests (requires credentials, costs money)
npm run test:live

# Run all tests
npm test                    # unit + integration + e2e (all parallel)
npx playwright test         # browser (parallel, half CPUs)
npm run test:live           # live (serial, opt-in)
npm run test:all            # lint + unit + integration + e2e + playwright
```

See `CLAUDE.md` → **Testing** section for the full 5-tier architecture, config details, and feature coverage table.

## Quality Checklist

Before considering tests done:

- [ ] At least 1 E2E test that verifies REST → Core → Event Bus → WebSocket
- [ ] State persistence tested (POST then GET to verify)
- [ ] Error cases tested (bad IDs, missing fields)
- [ ] Bidirectional operations tested if applicable (create/delete, complete/reopen)
- [ ] Multi-client WS tested if the feature emits events
- [ ] Playwright code test if the feature has visual components (`npx playwright test`)
- [ ] Playwright MCP screenshot for final visual verification
- [ ] All tests pass: `npm test && npx playwright test`

## Reference

See `CLAUDE.md` → **Testing** section for the full testing philosophy, pyramid, and feature coverage table.
