/**
 * Fix with agent on a host problem row and on System's backup and search
 * cards: the repair request, its pending and error states shared by every row
 * that shows the same host (All's problem list and System), a late answer that
 * opens nothing once the row is gone, and a real repair session on the mock
 * CLI. The rows live in the notification panel only (host-attention.ts).
 *
 * Run: walnut-dev run bun x playwright test tests/e2e/browser/host-fix-with-agent.spec.ts --project chromium-host-fixture --retries=0
 */
import { test, expect } from '@playwright/test';
import { connected, failed, resetServerHostFixture, setup } from './host-problems-helpers';
import {
  closePanel, healthyGitSync, openProblems, panelLocalCard, pickRail, problemHosts, problemRow, seedFeed, systemHostRow,
} from './host-attention-helpers';
import { fixtureFile, loadApp, loadFixture, openBell } from './host-problems-fixture-helpers';

const SHOTS = '/tmp/cloud-attention-fix/shots';
const fixFor = (name: string) => ({ name: `Fix with agent for ${name}`, exact: true });

test.beforeEach(async ({ request }) => { await resetServerHostFixture(request); });

test('a pending repair is one state in All and System and survives closing the panel; its failure shows in both, and a retry opens the returned task', async ({ page }) => {
  await healthyGitSync(page);
  const requests: Record<string, unknown>[] = [];
  let release!: () => void;
  await page.route('**/api/notifications/fix', async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await new Promise<void>((resolve) => { release = resolve; });
      await route.fulfill({ status: 409, json: { error: 'Host has no current failure to repair; recheck its status' } });
    } else await route.fulfill({ json: { taskId: 'attention-returned-task', reused: true } });
  });
  await setup(page, [failed('alpha', 'Alpha box', 'unreachable')], undefined, { listHosts: true });
  await openProblems(page);
  const allFix = problemRow(page, 'alpha').getByTestId('host-agent-fix');
  await problemRow(page, 'alpha').getByRole('button', fixFor('Alpha box')).click();
  await expect(allFix).toHaveText('Starting...');
  await pickRail(page, 'System');
  await expect(systemHostRow(page, 'alpha').getByTestId('host-agent-fix')).toBeDisabled();
  await expect(systemHostRow(page, 'alpha').getByTestId('host-agent-fix')).toHaveText('Starting...');
  // Closing and reopening the panel keeps the attempt (the store is not the row's).
  await closePanel(page, 'close');
  await openProblems(page);
  await expect(allFix).toHaveText('Starting...');
  expect(requests).toEqual([{ host: 'alpha' }]);
  release();
  await expect(problemRow(page, 'alpha').locator('.host-agent-fix-error')).toContainText('no current failure');
  await pickRail(page, 'System');
  await expect(systemHostRow(page, 'alpha').locator('.host-agent-fix-error')).toContainText('no current failure');
  await pickRail(page, 'All');
  await problemRow(page, 'alpha').getByRole('button', fixFor('Alpha box')).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.notification-panel')).toHaveCount(0);
  // The returned task opens on Home (there is no task page).
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  expect(requests).toEqual([{ host: 'alpha' }, { host: 'alpha' }]);
});

test('each host row repairs its own host; backup/search errors have typed actions; none is offered while Claude Code here cannot run', async ({ page }) => {
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/notifications/fix', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { error: 'Repair unavailable. Retry later.' } });
  });
  await page.route('**/api/git-sync/status', (route) => route.fulfill({ json: { protected: false, consecutiveFailures: 3, error: 'Backup failed' } }));
  await page.route('**/api/search-index/status', (route) => route.fulfill({ json: { status: 'error', error: 'Search failed', model: { name: 'Test model', downloaded: true }, stores: {} } }));
  // A repair session runs on Claude Code here, so it is signed in (local-agent-runnable.ts).
  const hosts = await setup(page, [failed('alpha', 'Alpha box', 'cert_expired'), failed('beta', 'Beta box', 'cert_expired')], 'ready', { listHosts: true });
  await openProblems(page);
  // One row per host (no credential group), so one repair per host.
  await expect(problemHosts(page).getByRole('button', { name: /^Fix with agent for / })).toHaveCount(2);
  await expect(problemRow(page, 'beta').getByRole('button', fixFor('Beta box'))).toBeVisible();
  await problemRow(page, 'alpha').getByRole('button', fixFor('Alpha box')).click();
  await expect(problemRow(page, 'alpha').locator('.host-agent-fix-error')).toContainText('Retry later');
  await expect(problemRow(page, 'beta').locator('.host-agent-fix-error')).toHaveCount(0);
  expect(requests[0]).toEqual({ host: 'alpha' });
  await pickRail(page, 'System');
  await page.getByRole('button', fixFor('Data Backup')).click();
  await expect(page.locator('.notification-panel .host-agent-fix-error').first()).toContainText('Retry later');
  await page.getByRole('button', fixFor('Embedding Search')).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests.slice(1)).toEqual([{ system: 'backup' }, { system: 'search' }]);
  // Signed out here: a repair session would fail like the errors it was asked to fix, so no
  // Fix with agent is offered anywhere, this computer's included; its sign-in step is the way on.
  await hosts.health!.set('sign-in');
  await expect(page.getByRole('button', { name: /^Fix with agent for / })).toHaveCount(0, { timeout: 10_000 });
  await pickRail(page, 'All');
  await expect(panelLocalCard(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: /^Fix with agent for / })).toHaveCount(0);
  expect(requests).toHaveLength(3);
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
    // A task the fixture server seeds (test-server.ts), never the newest open one: a spec running
    // beside this one creates tasks and deletes them seconds later, and the first open task was
    // one of those (2026-11-16: N2-14's task, gone before the repair opened it).
    const { tasks } = await (await request.get('/api/tasks')).json() as { tasks: Array<{ id: string; phase: string }> };
    const taskId = tasks.find((task) => task.id === 'pw-task-quote' && task.phase !== 'COMPLETE')!.id;
    await page.route('**/api/notifications/fix', (route) => route.fulfill({ json: { taskId, reused: true } }));
    await setup(page, [failed('alpha', 'Alpha box', 'unreachable')], undefined, { listHosts: true });
    await openBell(page);
    await pickRail(page, section);
    await page.locator('.notification-panel').getByRole('button', { name: 'Fix with agent for Alpha box', exact: true }).click();
    await expect(page.locator('.notification-panel')).toHaveCount(0);
    // The task opens on Home, located and selected (navigateToTarget -> openTaskHere); there is
    // no task page.
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect(page.locator(`.todo-panel [data-task-id="${taskId}"]`)
      .and(page.locator('.task-focused, .todo-pinned-card-active'))).toHaveCount(1);
    await page.goBack();
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    await expect(page.locator('.notification-panel')).toHaveCount(0);
    expect(await page.evaluate(() => window.history.state?.walnutOverlay?.kind)).not.toBe('notifications');
  });
}

test('a late repair answer opens nothing once its host healed and its row left', async ({ page }) => {
  await healthyGitSync(page);
  let release!: () => void;
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route('**/api/notifications/fix', async (route) => {
    requested();
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { taskId: 'old-host-repair', reused: true } });
  });
  const hosts = await setup(page, [failed('alpha', 'Alpha box', 'cert_expired'), failed('beta', 'Beta box', 'cert_expired')], undefined, { listHosts: true });
  await openProblems(page);
  await problemRow(page, 'alpha').getByRole('button', fixFor('Alpha box')).click();
  await started;
  try {
    await hosts.push(connected('alpha', 'Alpha box'));
    await expect(problemRow(page, 'alpha')).toHaveCount(0, { timeout: 10_000 });
    const finished = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/notifications/fix');
    release();
    await finished;
    // Let a navigation the answer might start land before reading what it left.
    await page.waitForTimeout(500);
    await expect(page.locator('.notification-panel')).toBeVisible();
    await expect(page).not.toHaveURL(/old-host-repair/);
    await expect(problemRow(page, 'beta').getByRole('button', fixFor('Beta box'))).toBeEnabled();
  } finally { release(); }
});

test('a long repair failure stays fully readable in its row: a short scroll box the keyboard can scroll, the same after reopening the panel', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 960, height: 600 });
  await healthyGitSync(page);
  const error = Array.from({ length: 60 }, (_, i) => `Clone diagnostic ${i}: a long actionable error with retry details.`).join('\n');
  await page.route('**/api/notifications/fix', (route) => route.fulfill({ status: 503, json: { error } }));
  // A host's repair: this computer's own Fix with agent is never offered while Claude Code here
  // cannot run (local-agent-runnable.ts), and once it runs there is no local notice to repair.
  await setup(page, [failed('alpha', 'Alpha box', 'cert_expired')], 'ready', { listHosts: true });
  await openProblems(page);
  await problemRow(page, 'alpha').getByRole('button', fixFor('Alpha box')).click();
  const detail = problemRow(page, 'alpha').locator('.host-agent-fix-error');
  await expect(detail).toHaveText(error);
  const dimensions = await detail.evaluate((el) => ({ height: el.clientHeight, full: el.scrollHeight }));
  expect(dimensions.height).toBeLessThanOrEqual(72);
  expect(dimensions.full).toBeGreaterThan(dimensions.height);
  await detail.focus();
  await detail.press('End');
  await expect.poll(() => detail.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/${browserName}-long-repair-error.png` });
  await closePanel(page, 'escape');
  await openProblems(page);
  await expect(detail).toHaveText(error);
});

for (const phone of [false, true]) {
  test(`real host preflight starts and reuses an actual mock-CLI repair session on ${phone ? 'phone' : 'desktop'}`, async ({ page, request }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 740 });
    await loadFixture(request, fixtureFile({ alpha: { label: 'Alpha box', hostname: 'alpha.example.com', phase: 'failed', error: 'ssh: connect to host alpha.example.com port 22: No route to host' } }));
    await healthyGitSync(page);
    await loadApp(page);
    await openBell(page);
    await pickRail(page, 'All');
    const response = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/notifications/fix');
    await problemRow(page, 'alpha').getByRole('button', fixFor('Alpha box')).click({ timeout: 20_000 });
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
