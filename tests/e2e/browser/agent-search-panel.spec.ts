/**
 * ✦ AI task search panel above the normal search results.
 *
 * Both /api/search (instant lane) and /api/search/agent (AI lane) are stubbed
 * at the network edge — this spec verifies the UI contract (auto-trigger with
 * debounce, skeleton, rows render and click like normal results, error+Retry,
 * the ai_disabled permanent latch, the toggle), not the model call. The server
 * pipeline has its own unit suite (tests/core/task-search-agent*.test.ts).
 */
import { expect, test, type Page } from '@playwright/test';

const TARGET_TASK_ID = 'pw-task-001';
const QUERY = 'which task adds docx support';

// The toggle is a shared open-walnut- localStorage pref; parallel workers
// would fight over it. Serial = correctness.
test.describe.configure({ mode: 'serial' });

const AGENT_PAYLOAD = {
  summary: 'The Office-preview work lives in one session-created task.',
  results: [{
    taskId: TARGET_TASK_ID,
    title: 'Playwright test task',
    phase: 'TODO',
    project: 'pw-fixtures',
    evidence: 'npm install docx-preview xlsx — extend the file preview feature',
    confidence: 'high',
  }],
  model: 'haiku',
  tookMs: 1234,
  cached: false,
};

interface AgentStub {
  calls: string[];
}

/** Stub the AI lane; `respond` decides status/body per call index. */
async function stubAgentSearch(
  page: Page,
  respond: (callIndex: number) => { status: number; body: unknown; delayMs?: number },
): Promise<AgentStub> {
  const stub: AgentStub = { calls: [] };
  await page.route('**/api/search/agent**', async (route) => {
    const url = new URL(route.request().url());
    const index = stub.calls.length;
    stub.calls.push(url.searchParams.get('q') ?? '');
    const { status, body, delayMs } = respond(index);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return stub;
}

/** The instant lane returns nothing — the production failure shape where only
 *  the AI lane has an answer. */
async function stubEmptyInstantSearch(page: Page): Promise<void> {
  await page.route('**/api/search?**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) });
  });
}

async function openHome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.todo-panel')).toBeVisible();
  // Deterministic default: the AI lane toggle ON, latch cleared (fresh page).
  await page.evaluate(() => localStorage.setItem('open-walnut-agent-search', '1'));
}

test('auto-triggers once after settle: skeleton, then clickable rows above the results', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  const stub = await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD, delayMs: 800 }));
  await openHome(page);

  await page.locator('.todo-search-input').fill(QUERY);

  const panel = page.getByTestId('agent-search-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.agent-search-skeleton')).toBeVisible();

  const row = panel.locator(`.agent-search-row[data-task-id="${TARGET_TASK_ID}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.locator('.agent-search-row-title')).toHaveText('Playwright test task');
  await expect(row.locator('.agent-search-row-evidence')).toContainText('docx');
  await expect(panel.locator('.agent-search-model')).toBeVisible();

  // Exactly one request despite per-keystroke fills (fill = one input event,
  // but the debounce also guards the earlier keystroke path).
  expect(stub.calls).toEqual([QUERY]);

  // DOM order: the AI panel sits above the normal-lane content (here: the
  // empty state, since the instant lane found nothing — the exact production
  // scenario this feature exists for).
  const panelBox = await panel.boundingBox();
  const emptyBox = await page.locator('.todo-panel-list .empty-state').boundingBox();
  expect(panelBox!.y).toBeLessThan(emptyBox!.y);
});

test('clicking an AI row focuses the task like a normal result click', async ({ page }) => {
  // The instant lane ALSO returns the task here so its normal row is on
  // screen — clicking the AI row must focus that same row (`task-focused`),
  // proving the click path is identical to a normal result click.
  await page.route('**/api/search?**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [{ type: 'task', taskId: TARGET_TASK_ID, title: 'Playwright test task', snippet: QUERY, score: 1, matchField: 'task' }],
      }),
    });
  });
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD }));
  await openHome(page);

  await page.locator('.todo-search-input').fill(QUERY);
  const row = page.locator(`.agent-search-row[data-task-id="${TARGET_TASK_ID}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  const normalRow = page.locator(`.todo-search-results .todo-panel-item[data-task-id="${TARGET_TASK_ID}"]`);
  await expect(normalRow).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(normalRow).toHaveClass(/task-focused/, { timeout: 10_000 });
});

test('503 ai_disabled hides the panel and latches — no further requests', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  const stub = await stubAgentSearch(page, () => ({ status: 503, body: { error: 'off', code: 'ai_disabled' } }));
  await openHome(page);

  await page.locator('.todo-search-input').fill(QUERY);
  await expect.poll(() => stub.calls.length, { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId('agent-search-panel')).toBeHidden();

  await page.locator('.todo-search-input').fill('another eligible question entirely');
  await page.waitForTimeout(1800); // > debounce — a second call would have fired by now
  expect(stub.calls.length).toBe(1);
});

test('transient 502 shows error with Retry; Retry succeeds', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, (i) =>
    i === 0
      ? { status: 502, body: { error: 'agent failed', code: 'agent_failed' } }
      : { status: 200, body: AGENT_PAYLOAD });
  await openHome(page);

  await page.locator('.todo-search-input').fill(QUERY);
  const panel = page.getByTestId('agent-search-panel');
  await expect(panel.locator('.agent-search-error')).toBeVisible({ timeout: 10_000 });
  await panel.locator('.agent-search-retry').click();
  await expect(panel.locator(`.agent-search-row[data-task-id="${TARGET_TASK_ID}"]`))
    .toBeVisible({ timeout: 10_000 });
});

test('toggle off stops all requests and persists across reload', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  const stub = await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD }));
  await openHome(page);

  await page.locator('.todo-search-input').fill(QUERY);
  const panel = page.getByTestId('agent-search-panel');
  await expect(panel.locator('.agent-search-row').first()).toBeVisible({ timeout: 10_000 });
  const callsBefore = stub.calls.length;

  await panel.locator('.agent-search-header .agent-search-toggle').click();
  await expect(panel.locator('.agent-search-enable')).toBeVisible();

  await page.locator('.todo-search-input').fill('another eligible question entirely');
  await page.waitForTimeout(1800);
  expect(stub.calls.length).toBe(callsBefore);

  // Persisted: reload keeps it off.
  expect(await page.evaluate(() => localStorage.getItem('open-walnut-agent-search'))).toBe('0');
});

test('ineligible short query never fires the AI lane and never blocks typing', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  const stub = await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD }));
  await openHome(page);

  const input = page.locator('.todo-search-input');
  await input.pressSequentially('abc', { delay: 40 });
  await page.waitForTimeout(1500);
  expect(stub.calls.length).toBe(0);
  await expect(input).toHaveValue('abc');

  // Fast typing of an eligible query: input tracks every char, exactly one call.
  await input.fill('');
  await input.pressSequentially(QUERY, { delay: 30 });
  await expect(input).toHaveValue(QUERY);
  await expect.poll(() => stub.calls.length, { timeout: 10_000 }).toBe(1);
  expect(stub.calls).toEqual([QUERY]);
});
