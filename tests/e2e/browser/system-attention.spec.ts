import { test, expect, type Page } from '@playwright/test';
import { banner, base, connected, failed, resetServerHostFixture, row, setup, slotLayout, storedKeys } from './host-problems-helpers';
import { closePanel, healthyGitSync, openSystemHosts, pickRail, seedFeed, systemHostRow } from './banner-placement-helpers';
import { fixtureFile, loadApp, loadFixture } from './host-problems-fixture-helpers';
import { openBell } from './host-problems-fixture-helpers';

const SHOTS = '/tmp/cloud-attention-fix/shots';
const toggle = (page: Page) => page.locator('.todo-panel .system-attention-toggle');
async function expand(page: Page): Promise<void> {
  await expect(toggle(page)).toBeVisible();
  if (await toggle(page).getAttribute('aria-expanded') === 'false') await toggle(page).click();
}
async function count(page: Page, n: number): Promise<void> {
  await expect(page.locator('.todo-panel .system-attention-count')).toHaveText(String(n));
}

test.beforeEach(async ({ request }) => { await resetServerHostFixture(request); });

test('bottom disclosure defaults collapsed, stays live and does not count feedback or held rows', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await healthyGitSync(page);
  const hosts = await setup(page, [failed('alpha', 'Alpha box', 'cert_expired'), failed('beta', 'Beta box', 'cert_expired')]);
  await count(page, 2);
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(banner(page)).toBeHidden();
  await expect(banner(page)).toBeAttached();
  const order = await page.locator('.todo-panel').evaluate((panel) => {
    const section = panel.querySelector('.ab-mount')!;
    const list = panel.querySelector('.home-navigation-scroll')!;
    return { outside: !list.contains(section), after: !!(list.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING),
      // The panel's last element: the filter footer that used to follow it is gone.
      last: section === panel.lastElementChild,
      toolbarNext: !!panel.querySelector('.todo-panel-toolbar')?.nextElementSibling?.classList.contains('ab-mount') };
  });
  expect(order).toEqual({ outside: true, after: true, last: true, toolbarNext: false });
  await page.screenshot({ path: `${SHOTS}/${browserName}-collapsed.png` });
  const beforeKeys = await storedKeys(page);
  await toggle(page).focus();
  await toggle(page).press('Enter');
  await expect(banner(page)).toBeVisible();
  await toggle(page).press('Space');
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  expect(await storedKeys(page)).toEqual(beforeKeys);
  await hosts.push(failed('gamma', 'Gamma box', 'unreachable'));
  await count(page, 3);
  await hosts.push({ ...base('alpha', 'Alpha box'), removed: true });
  await count(page, 2);
  await hosts.push(connected('beta', 'Beta box'));
  await count(page, 1);
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  await expand(page);
  await row(page, 'gamma').getByRole('button', { name: 'Dismiss Gamma box', exact: true }).click();
  await count(page, 0);
  await toggle(page).click();
  await expect(toggle(page)).toContainText('Undo available');
  await expand(page);
  const undo = banner(page).getByRole('button', { name: 'Undo', exact: true }).last();
  await expect(undo).toBeEnabled();
  await page.waitForTimeout(450);
  await undo.click();
  await count(page, 1);
  await row(page, 'gamma').getByRole('button', { name: 'Dismiss Gamma box', exact: true }).click();
  await toggle(page).click();
  await page.mouse.move(0, 0);
  await expect(toggle(page)).toHaveCount(0, { timeout: 13_000 });
  await hosts.push(failed('delta', 'Delta box', 'unreachable'));
  await count(page, 1);
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
});

test('shared repair pending survives collapse and notification switches, then failure retries to a real returned task', async ({ page }) => {
  await healthyGitSync(page);
  let requests: Record<string, unknown>[] = [];
  let release!: () => void;
  await page.route('**/api/notifications/fix', async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await new Promise<void>((resolve) => { release = resolve; });
      await route.fulfill({ status: 409, json: { error: 'Host has no current failure to repair; recheck its status' } });
    } else await route.fulfill({ json: { taskId: 'attention-returned-task', reused: true } });
  });
  await setup(page, [failed('alpha', 'Alpha box', 'unreachable')], undefined, { listHosts: true });
  await expand(page);
  await row(page, 'alpha').getByRole('button', { name: 'Fix with agent for Alpha box', exact: true }).click();
  await expect(row(page, 'alpha').getByTestId('host-agent-fix')).toHaveText('Starting...');
  await toggle(page).click();
  await openSystemHosts(page);
  await expect(systemHostRow(page, 'alpha').getByTestId('host-agent-fix')).toBeDisabled();
  await pickRail(page, 'All');
  await expect(page.locator('.notification-panel [data-host="alpha"] [data-testid="host-agent-fix"]').first()).toHaveText('Starting...');
  expect(requests).toEqual([{ host: 'alpha' }]);
  release();
  await expect(page.locator('.notification-panel .host-agent-fix-error').first()).toContainText('no current failure');
  await closePanel(page, 'close');
  await expand(page);
  await expect(row(page, 'alpha').locator('.host-agent-fix-error')).toBeVisible();
  await count(page, 1);
  await row(page, 'alpha').getByRole('button', { name: 'Fix with agent for Alpha box', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tasks\/attention-returned-task$/);
  expect(requests).toEqual([{ host: 'alpha' }, { host: 'alpha' }]);
});

test('credential repair sends the whole group once; local and backup/search errors have typed actions', async ({ page }) => {
  let requests: Record<string, unknown>[] = [];
  await page.route('**/api/notifications/fix', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { error: 'Repair unavailable. Retry later.' } });
  });
  await page.route('**/api/git-sync/status', (route) => route.fulfill({ json: { protected: false, consecutiveFailures: 3, error: 'Backup failed' } }));
  await page.route('**/api/search-index/status', (route) => route.fulfill({ json: { status: 'error', error: 'Search failed', model: { name: 'Test model', downloaded: true }, stores: {} } }));
  await setup(page, [failed('alpha', 'Alpha box', 'cert_expired'), failed('beta', 'Beta box', 'cert_expired')], 'sign-in', { listHosts: true });
  await count(page, 3);
  await expand(page);
  await banner(page).getByRole('button', { name: 'Fix with agent for Alpha box, Beta box', exact: true }).click();
  await expect(banner(page).locator('.host-agent-fix-error').last()).toContainText('Retry later');
  expect(requests[0]).toEqual({ hosts: ['alpha', 'beta'] });
  await banner(page).getByRole('button', { name: 'Fix with agent for this computer', exact: true }).click();
  await expect(banner(page).locator('.ab-local .host-agent-fix-error')).toContainText('Retry later');
  expect(requests[1]).toEqual({ host: '__local__' });
  await openSystemHosts(page);
  await page.getByRole('button', { name: 'Fix with agent for Data Backup', exact: true }).click();
  await expect(page.locator('.notification-panel .host-agent-fix-error').first()).toContainText('Retry later');
  await page.getByRole('button', { name: 'Fix with agent for Embedding Search', exact: true }).click();
  await expect.poll(() => requests.length).toBe(4);
  expect(requests.slice(2)).toEqual([{ system: 'backup' }, { system: 'search' }]);
});

test('12 host faults leave 100 tasks usable in narrow short light and dark panels', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 960, height: 600 });
  await healthyGitSync(page);
  const res = await page.request.get('/api/tasks');
  const original = await res.json();
  const seed = original.tasks.find((task: { phase: string }) => task.phase !== 'COMPLETE');
  expect(seed).toBeTruthy();
  const tasks = Array.from({ length: 100 }, (_, i) => ({ ...seed, id: `attention-task-${i}`, title: `Task ${String(i + 1).padStart(3, '0')}`, project: '', group_id: undefined, pinned: true, focus_tier: 'focus', phase: 'TODO', parent_task_id: undefined }));
  await page.route('**/api/tasks?*', (route) => route.fulfill({ json: { tasks, completedHidden: 0 } }));
  await page.route('**/api/tasks', (route) => route.request().method() === 'GET' ? route.fulfill({ json: { tasks, completedHidden: 0 } }) : route.fallback());
  await setup(page, Array.from({ length: 12 }, (_, i) => failed(`box${i}`, `Long neutral workstation ${String(i).padStart(2, '0')}`, 'unreachable')));
  await page.locator('.main-page-todo').evaluate((el) => { Object.assign((el as HTMLElement).style, { width: '360px', minWidth: '360px', maxWidth: '360px', height: '400px', flex: 'none' }); });
  await count(page, 12);
  await expand(page);
  await expect(banner(page).locator('.hpb-more')).toHaveText('and 9 more');
  const fix = row(page, 'box0').getByRole('button', { name: 'Fix with agent for Long neutral workstation 00', exact: true });
  await expect(fix).toBeVisible();
  await fix.focus();
  await expect(fix).toBeFocused();
  await expect.poll(() => row(page, 'box0').locator('.hft-headline').evaluate((el) => {
    const headline = el.getBoundingClientRect();
    const scroll = el.closest('.hpb-scroll')!.getBoundingClientRect();
    const fix = el.closest('.hpb-row')!.querySelector('.host-agent-fix-button')!.getBoundingClientRect();
    const card = el.closest('.attention-banner')!.getBoundingClientRect();
    return headline.top >= scroll.top - 1 && headline.bottom <= scroll.bottom + 1
      && fix.top >= scroll.top - 1 && fix.bottom <= scroll.bottom + 1 && fix.bottom <= card.bottom + 1;
  })).toBe(true);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await page.screenshot({ path: `${SHOTS}/${browserName}-360-short-${theme}-expanded.png` });
    await toggle(page).click();
    await page.screenshot({ path: `${SHOTS}/${browserName}-360-short-${theme}-collapsed.png` });
    await expand(page);
  }
  expect(await page.locator('.todo-panel').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.locator('.home-navigation-scroll').evaluate((el) => el.clientHeight)).toBeGreaterThan(24);
});

test('hiding the task panel retains the existing single owner fallback', async ({ page }) => {
  await slotLayout(page);
  await healthyGitSync(page);
  await setup(page, [failed('alpha', 'Alpha box', 'unreachable')]);
  await expect(page.locator('.main-page-chat [data-testid="attention-banner"]')).toBeVisible();
  await expect(page.locator('[data-testid="attention-banner"]')).toHaveCount(1);
  await expect(toggle(page)).toHaveCount(0);
});

test('automation error cards offer repair while unrelated letter and permission records do not', async ({ page }) => {
  await healthyGitSync(page);
  await seedFeed(page, ['cron', 'skill', 'hook', 'letter', 'permission'].map((kind, i) => ({
    id: `attention-feed-${kind}`, dedupKey: `attention-${kind}`, kind, severity: 'error', title: `Attention ${kind}`, body: 'Test failure', timestamp: Date.now() - i * 1000, read: true,
  })));
  await setup(page, []);
  await openBell(page);
  await pickRail(page, 'All');
  for (const kind of ['cron', 'skill', 'hook']) {
    await expect(page.locator('.notification-feed-item').filter({ hasText: `Attention ${kind}` }).getByTestId('nfc-fix-start')).toBeVisible();
  }
  for (const kind of ['letter', 'permission']) {
    await expect(page.locator('.notification-feed-item').filter({ hasText: `Attention ${kind}` }).getByTestId('nfc-fix-start')).toHaveCount(0);
  }
});

for (const section of ['All', 'System']) {
  test(`phone ${section} repair closes the notification history entry before opening its task`, async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.addInitScript(() => localStorage.setItem('open-walnut-home-chat-visible', 'false'));
    await healthyGitSync(page);
    const { tasks } = await (await request.get('/api/tasks')).json();
    const taskId = tasks.find((task: { phase: string }) => task.phase !== 'COMPLETE').id;
    await page.route('**/api/notifications/fix', (route) => route.fulfill({ json: { taskId, reused: true } }));
    await setup(page, [failed('alpha', 'Alpha box', 'unreachable')], undefined, { listHosts: true });
    await openBell(page);
    await pickRail(page, section);
    await page.locator('.notification-panel').getByRole('button', { name: 'Fix with agent for Alpha box', exact: true }).click();
    await expect(page.locator('.notification-panel')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
    await page.goBack();
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    await expect(page.locator('.notification-panel')).toHaveCount(0);
    expect(await page.evaluate(() => window.history.state?.walnutOverlay?.kind)).not.toBe('notifications');
  });
}

test('a late group repair cannot navigate after its fault membership changes', async ({ page }) => {
  await healthyGitSync(page);
  let release!: () => void;
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route('**/api/notifications/fix', async (route) => {
    requested();
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { taskId: 'old-group-repair', reused: true } });
  });
  const hosts = await setup(page, [failed('alpha', 'Alpha box', 'cert_expired'), failed('beta', 'Beta box', 'cert_expired')]);
  await expand(page);
  await banner(page).getByRole('button', { name: 'Fix with agent for Alpha box, Beta box', exact: true }).click();
  await started;
  try {
    await page.mouse.move(0, 0);
    await hosts.push(connected('alpha', 'Alpha box'));
    await hosts.push(failed('gamma', 'Gamma box', 'cert_expired'));
    await expect(banner(page).getByRole('button', { name: 'Fix with agent for Beta box, Gamma box', exact: true })).toBeEnabled();
    const finished = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/notifications/fix');
    release();
    await finished;
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page).not.toHaveURL(/old-group-repair/);
    await expand(page);
    await expect(banner(page).getByRole('button', { name: 'Fix with agent for Beta box, Gamma box', exact: true })).toBeEnabled();
  } finally { release(); }
});

test('long local repair failures remain fully readable without consuming the short task panel', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 960, height: 600 });
  await healthyGitSync(page);
  const error = Array.from({ length: 60 }, (_, i) => `Clone diagnostic ${i}: a long actionable error with retry details.`).join('\n');
  await page.route('**/api/notifications/fix', (route) => route.fulfill({ status: 503, json: { error } }));
  await setup(page, [], 'sign-in');
  await page.locator('.main-page-todo').evaluate((el) => { Object.assign((el as HTMLElement).style, { width: '360px', minWidth: '360px', maxWidth: '360px', height: '400px', flex: 'none' }); });
  await expand(page);
  await banner(page).getByRole('button', { name: 'Fix with agent for this computer', exact: true }).click();
  const detail = banner(page).locator('.host-agent-fix-error');
  await expect(detail).toHaveText(error);
  const dimensions = await detail.evaluate((el) => ({ height: el.clientHeight, full: el.scrollHeight }));
  expect(dimensions.height).toBeLessThanOrEqual(72);
  expect(dimensions.full).toBeGreaterThan(dimensions.height);
  await detail.focus();
  await detail.press('End');
  await expect.poll(() => detail.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator('.home-navigation-scroll').evaluate((el) => el.clientHeight)).toBeGreaterThan(60);
  await page.screenshot({ path: `${SHOTS}/${browserName}-local-long-error.png` });
  await toggle(page).click();
  await expand(page);
  await expect(detail).toHaveText(error);
});

for (const phone of [false, true]) {
  test(`real host preflight starts and reuses an actual mock-CLI repair session on ${phone ? 'phone' : 'desktop'}`, async ({ page, request }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 740 });
    await loadFixture(request, fixtureFile({ alpha: { label: 'Alpha box', hostname: 'alpha.example.com', phase: 'failed', error: 'ssh: connect to host alpha.example.com port 22: No route to host' } }));
    await healthyGitSync(page);
    await loadApp(page);
    await count(page, 1);
    if (phone) {
      await openBell(page);
      await pickRail(page, 'All');
    } else await expand(page);
    const response = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/notifications/fix');
    const entry = phone ? page.locator('.notification-panel [data-host="alpha"]') : row(page, 'alpha');
    await entry.getByRole('button', { name: 'Fix with agent for Alpha box', exact: true }).click();
    const first = await response;
    expect(first.status(), await first.text()).toBe(200);
    const result = await first.json();
    expect(result.taskId).toBeTruthy();
    expect(result.sessionId).toBeTruthy();
    await expect(page.locator('.notification-panel')).toHaveCount(0);
    await expect(page.locator(`.main-page-session-column [data-session-id="${result.sessionId}"]`)).toBeVisible({ timeout: 20_000 });
    if (phone) {
      expect(await page.evaluate(() => window.history.state?.walnutOverlay?.kind)).toBe('session');
      await page.goBack();
      await expect(page.locator('.main-page-session-column.is-mobile-active')).toHaveCount(0);
      await expect(page.locator('.notification-panel')).toHaveCount(0);
    }
    const task = await (await request.get(`/api/tasks/${result.taskId}`)).json();
    expect(task.task.id).toBe(result.taskId);
    const reused = await request.post('/api/notifications/fix', { data: { host: 'alpha' } });
    expect(reused.status()).toBe(200);
    expect(await reused.json()).toMatchObject({ taskId: result.taskId, sessionId: result.sessionId, reused: true });
  });
}
