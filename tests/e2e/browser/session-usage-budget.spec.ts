import { test, expect } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';
import { openKebabGroup } from './kebab-group-helpers';

test.setTimeout(180_000);
test('session budget keeps dirty edits, conflicts, pauses and recovery honest', async ({ page }, testInfo) => {
  await isolateUiPrefs(page);
  let sentMessages = 0;
  let targetSessionId: string | undefined;
  page.on('websocket', socket => socket.on('framesent', frame => {
    try {
      const row = JSON.parse(String(frame.payload));
      if (row.method === 'session:send' && row.payload?.sessionId === targetSessionId) sentMessages++;
    } catch { /* Other transport frames do not send a session message. */ }
  }));
  await page.setViewportSize({ width: 1200, height: 850 });
  const bootUrl = String(testInfo.project.use.baseURL) + '/';
  const cdp = await page.context().newCDPSession(page).catch(() => null);
  if (cdp) await cdp.send('Page.navigate', { url: bootUrl });
  else await page.evaluate(url => { location.href = url; }, bootUrl);
  // A cold first boot of the app took over 30 s at load 60 (2026-10-25); the picker spec allows 90 s too.
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 90_000 });
  const created = await page.request.post('/api/sessions/quick-start', {
    data: { cwd: process.cwd(), message: 'Controlled allowance fixture', project: 'Usage Fixture' },
  });
  expect(created.status(), await created.text()).toBe(200);
  const { sessionId, taskId } = await created.json();
  let current = {
    sessionId, title: 'Review the monthly usage', engine: 'claude', checkEverySec: 2,
    budget: { limitUsd: 10 as number | null, spentUsd: 5.99 as number | null, state: 'active', reason: null as string | null, revision: 1,
      updatedAt: new Date().toISOString(), responses: 18, unpricedResponses: 0, unpricedModel: null as string | null, pausedAt: null as string | null,
      pauseId: null as string | null, stopError: null as string | null, engine: 'claude' },
    checkedAt: new Date().toISOString(),
  };
  // The breakdown is the picker's own cost block, here with twenty models.
  const models = Array.from({ length: 20 }, (_, index) => ({ model: `example-model-${index}`, speed: 'standard', responses: 1, costUsd: 0.3,
    unpricedResponses: 0, longResponses: 0, webSearches: 0, usRegionResponses: 0,
    tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0 },
    rates: { input: 3, output: 15 }, tiers: [], firstAt: '2026-10-20T00:00:00.000Z', lastAt: '2026-10-20T01:00:00.000Z' }));
  await page.route(`**/api/sessions/${sessionId}/cost`, route => route.fulfill({ json: { sessionId, engine: 'claude', source: 'claude-transcript',
    status: 'priced', totalUsd: 5.99, responses: 18, unpricedResponses: 0, firstAt: '2026-10-20T00:00:00.000Z', lastAt: '2026-10-20T01:00:00.000Z',
    prices: { source: 'litellm', asOf: '2026-10-20T00:00:00.000Z' }, models } }));
  targetSessionId = sessionId;
  let rejectConflict = false, rejectSave = false, offline = false, patchCount = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/sessions\/.*\/messages/.test(request.url())) sentMessages++; });
  await page.route(`**/api/usage/sessions/${sessionId}`, route => offline
    ? route.fulfill({ status: 503, json: { error: 'Host unavailable' } }) : route.fulfill({ json: current }));
  await page.route(`**/api/usage/sessions/${sessionId}/budget`, async route => {
    patchCount++;
    if (rejectSave) { rejectSave = false; await route.fulfill({ status: 503, json: { error: 'Host unavailable' } }); return; }
    if (rejectConflict) {
      rejectConflict = false; current.budget.revision++;
      await route.fulfill({ status: 409, json: { error: 'Budget changed elsewhere' } }); return;
    }
    const body = route.request().postDataJSON();
    current = { ...current, budget: { ...current.budget, limitUsd: body.limitUsd, revision: current.budget.revision + 1,
      state: body.limitUsd === null ? 'unlimited' : (current.budget.spentUsd ?? 0) >= body.limitUsd ? 'paused' : 'active',
      reason: body.limitUsd === null ? null : (current.budget.spentUsd ?? 0) >= body.limitUsd ? 'limit' : null } };
    await route.fulfill({ json: current });
  });
  await page.locator('.todo-search-input').fill(taskId);
  const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`);
  await expect(task).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => {
    const response = await page.request.get(`/api/tasks/${taskId}`);
    const body = await response.json();
    const task = body.task;
    return task.session_id || task.exec_session_id || task.plan_session_id || task.session_ids?.at(-1);
  }).toBe(sessionId);
  await task.click({ position: { x: 12, y: 12 } });
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sessionId}"]`);
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'More actions', exact: true }).click();
  // Usage & Budget is a row of the menu's Views group.
  const views = await openKebabGroup(page.locator('.task-kebab-menu:visible'), 'session-kebab-views');
  await views.getByRole('button', { name: 'Usage & Budget', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Usage & Budget' });
  await expect(dialog).toBeVisible(); await expect(dialog.locator('.session-usage-total strong')).toHaveText('$5.99');
  await expect(dialog.getByText('Checked after each response and every 2 s, subagents included.', { exact: false })).toBeVisible();
  await expect(dialog.getByText('Remaining: $4.01')).toBeVisible();
  const input = dialog.getByRole('textbox', { name: 'Budget for this session (USD)' });
  await input.fill('20');
  current.budget.revision = 2; current.budget.limitUsd = 15;
  await expect(dialog.getByText('Saved limit: $15.00')).toBeVisible({ timeout: 12_000 });
  await expect(input).toHaveValue('20');
  rejectConflict = true; await dialog.getByRole('button', { name: 'Save limit' }).click();
  await expect(dialog.getByText(/Latest values are shown; your edit is kept/)).toBeVisible();
  await expect(input).toHaveValue('20'); await dialog.getByRole('button', { name: 'Save limit' }).click();
  await expect(dialog.getByText('Saved limit: $20.00')).toBeVisible();
  expect(patchCount).toBe(2); expect(sentMessages).toBe(0);
  await input.fill('30'); rejectSave = true;
  await dialog.getByRole('button', { name: 'Save limit' }).click();
  await expect(dialog.getByText(/Could not save the budget/)).toBeVisible();
  await expect(input).toHaveValue('30');
  await dialog.getByRole('button', { name: 'Save limit' }).click();
  await expect(dialog.getByText('Saved limit: $30.00')).toBeVisible();
  expect(sentMessages).toBe(0);
  await page.screenshot({ path: `/tmp/walnut-session-cost/budget/${testInfo.project.name}-dialog.png` });
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.locator('.session-cost-head').click();
  await dialog.getByTestId('session-cost-model').nth(19).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/walnut-session-cost/budget/${testInfo.project.name}-dense-320.png` });
  // A request on a model with no price pauses the session; the host says which model.
  current = { ...current, budget: { ...current.budget, state: 'paused', reason: 'unpriced', unpricedModel: 'example-new-model', unpricedResponses: 1,
    pausedAt: new Date().toISOString(), pauseId: 'pause-1' } };
  await expect(dialog.getByText('Paused: a request on example-new-model has no price').first()).toBeVisible({ timeout: 12_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel.locator('.session-budget-status')).toContainText('Paused: a request on example-new-model has no price');
  await panel.locator('.session-budget-status').getByRole('button', { name: 'Usage & Budget' }).click();
  offline = true;
  await expect(dialog.getByRole('button', { name: 'Retry refresh' })).toBeVisible({ timeout: 12_000 });
  offline = false; await dialog.getByRole('button', { name: 'Retry refresh' }).click();
  await expect(dialog.getByRole('button', { name: 'Retry refresh' })).toBeHidden();
  await dialog.getByRole('button', { name: 'Remove limit' }).click();
  await expect(dialog.getByText('Saved limit: No limit')).toBeVisible();
  expect(sentMessages).toBe(0);
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  await expect(panel.locator('.session-budget-status')).toBeHidden();
});
