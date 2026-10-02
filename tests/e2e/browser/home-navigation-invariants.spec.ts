import { test, expect, type Page } from '@playwright/test';
import { isolateUiPrefs, selectProject } from './todo-panel-helpers';
import { arrange, chooseViewOption, openHome, setShowCompleted } from './home-navigation-helpers';
import { displayButton, setStatus } from './filter-bar-helpers';

test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 });
test.setTimeout(90_000);

async function boot(page: Page, baseURL: string) {
  await isolateUiPrefs(page);
  await openHome(page, baseURL);
}

test('completed pins remain available and filtering never expands unrelated projects', async ({ page, baseURL }) => {
  const ids: string[] = [];
  for (const project of ['Navigation Alpha', 'Navigation Beta']) {
    const response = await page.request.post('/api/tasks', { data: { title: `${project} task`, project, source: 'local' } });
    expect(response.ok()).toBe(true);
    ids.push((await response.json()).task.id);
  }
  expect((await page.request.delete(`/api/focus/tasks/${ids[1]}`)).ok()).toBe(true);
  expect((await page.request.post(`/api/focus/tasks/${ids[0]}`)).ok()).toBe(true);
  expect((await page.request.patch(`/api/tasks/${ids[0]}`, { data: { phase: 'COMPLETE' } })).ok()).toBe(true);
  await boot(page, baseURL!);
  await setShowCompleted(page, true);
  await selectProject(page, 'Navigation Alpha');
  const project = (name: string) => page.locator('.todo-group-project').filter({ has: page.locator('.todo-group-project-name', { hasText: new RegExp(`^${name}$`) }) });
  const pinnedCard = page.locator(`.todo-pinned-section [data-task-id="${ids[0]}"]`);
  // In All a pin draws ONCE, in the pinned area (C25 + C48): the completed pin is on screen
  // there under its project chip, the list holds no copy, and the other project is not drawn.
  await expect(pinnedCard).toBeVisible();
  await expect(page.locator(`.todo-panel-list [data-task-id="${ids[0]}"]`)).toHaveCount(0);
  await expect(project('Navigation Beta')).toHaveCount(0);
  await selectProject(page, 'All');
  // With every chip off the list shows the user's own folds again: what a filter opened
  // was never saved as opened by the user, so the unrelated project is folded.
  await setShowCompleted(page, false);
  await expect(project('Navigation Beta').locator('.todo-group-project-name')).toBeVisible();
  await expect(project('Navigation Beta').locator('.todo-panel-item')).toHaveCount(0);
  const opened = await page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-list-opened') ?? '[]'));
  expect(opened).not.toContain('Navigation Alpha');
  expect(opened).not.toContain('Navigation Beta');
  await setShowCompleted(page, true);
  await arrange(page, 'Flat');
  await chooseViewOption(page, 'collapse');
  await arrange(page, 'By project');
  await expect(project('Navigation Beta').locator('.todo-panel-item')).toHaveCount(0);
  await chooseViewOption(page, 'collapse');
  await expect(project('Navigation Beta').locator(`[data-task-id="${ids[1]}"]`)).toBeAttached();
  await expect(pinnedCard).toBeAttached();
  await page.reload();
  await expect(displayButton(page)).toBeVisible({ timeout: 30_000 });
  await setShowCompleted(page, true);
  await expect(pinnedCard).toBeAttached();
});

test('calendar day and task scheduling survive closing the panel without leaked popovers', async ({ page, baseURL }) => {
  await boot(page, baseURL!);
  const agenda = page.getByTestId('sidebar-toggle-calendar');
  await agenda.click();
  const calendar = page.getByTestId('cal-side-panel');
  for (let step = 0; step < (test.info().project.name === 'webkit' ? 3 : 2); step++) await calendar.getByRole('button', { name: 'Next day' }).click();
  const day = await calendar.locator('.cal-day-col').getAttribute('data-day');
  await agenda.click();
  await expect(calendar).toBeHidden();
  await agenda.click();
  await expect(calendar.locator('.cal-day-col')).toHaveAttribute('data-day', day!);
  await calendar.getByRole('button', { name: 'Choose calendars' }).click();
  await expect(page.locator('.cal-cals-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cal-cals-popover')).toHaveCount(0);
  await expect(calendar).toBeVisible();
  await calendar.locator('.cal-allday-cell').click({ position: { x: 8, y: 8 } });
  const creator = page.locator('.cal-create-popover');
  await expect(creator).toBeVisible();
  await creator.getByPlaceholder('Task title', { exact: true }).fill('Companion scheduled task');
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks');
  await creator.getByRole('button', { name: 'Create', exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const task = (await response.json()).task;
  expect(task.start_date).toBe(day);
  await expect(creator).toHaveCount(0);
  await expect(calendar).toContainText('Companion scheduled task');
  await calendar.locator('[title="Close calendar panel"]').click();
  await expect(page.locator('.cal-popover-backdrop')).toHaveCount(0);
  await expect(calendar).toBeHidden();
  await expect(page.locator('.cal-cals-popover,.cal-create-popover,.cal-item-popover')).toHaveCount(0);
  await agenda.click();
  await expect(calendar.locator('.cal-day-col')).toHaveAttribute('data-day', day!);
});

test('menu sorting keeps completed pins in their original slots', async ({ page, baseURL }) => {
  const tierResponse = await page.request.post('/api/focus/tiers', { data: { label: `Order ${test.info().project.name} ${test.info().repeatEachIndex}` } });
  expect(tierResponse.ok()).toBe(true);
  const tierId = (await tierResponse.json()).tier.id;
  const ids: string[] = [];
  for (const title of ['First row', 'Completed row', 'Last row']) {
    const response = await page.request.post('/api/tasks', { data: { title, project: 'Menu ordering', source: 'local' } });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).task.id;
    ids.push(id);
    expect((await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: tierId } })).ok()).toBe(true);
  }
  expect((await page.request.patch(`/api/tasks/${ids[1]}`, { data: { phase: 'COMPLETE' } })).ok()).toBe(true);
  const all = (await (await page.request.get('/api/focus/tasks')).json()).pinned_tasks as string[];
  const own = new Set(ids);
  const before = [...all.filter(id => !own.has(id)), ...ids];
  expect((await page.request.put('/api/focus/reorder', { data: { task_ids: before } })).ok()).toBe(true);
  await boot(page, baseURL!);
  const row = page.locator(`[data-drop-zone="${tierId}-drop-zone"] [data-task-id="${ids[2]}"]`);
  await expect(row).toBeVisible();
  await expect(page.locator(`[data-drop-zone="${tierId}-drop-zone"] [data-task-id="${ids[1]}"]`)).toHaveCount(0, { timeout: 10_000 });
  await row.hover();
  await row.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.locator('.task-kebab-item').filter({ hasText: 'Move up' }).click();
  // Compare only this test's own pins: parallel workers pin tasks on the same
  // fixture board, so the global list is not ours to pin exactly. Move up swaps
  // the two open rows around the completed one, which keeps its middle slot.
  await expect.poll(async () => ((await (await page.request.get('/api/focus/tasks')).json()).pinned_tasks as string[])
    .filter((id) => own.has(id))).toEqual([ids[2], ids[1], ids[0]]);
  // Leave no custom tier behind: other specs count the tabs on the shared bar.
  for (const id of ids) await page.request.delete(`/api/tasks/${id}?force=true`).catch(() => {});
  await page.request.delete(`/api/focus/tiers/${tierId}`).catch(() => {});
});

test('project title drag and keyboard menu sorting preserve task ownership', async ({ page, baseURL }) => {
  const suffix = test.info().project.name;
  const tierResponse = await page.request.post('/api/focus/tiers', { data: { label: `Projects ${suffix}` } });
  expect(tierResponse.ok()).toBe(true);
  const tierId = (await tierResponse.json()).tier.id;
  const projects = [`Order A ${suffix}`, `Order B ${suffix}`];
  const tasks: string[] = [];
  for (const project of projects) {
    const response = await page.request.post('/api/tasks', { data: { title: `${project} item`, project, source: 'local' } });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).task.id;
    tasks.push(id);
    expect((await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: tierId } })).ok()).toBe(true);
  }
  await page.addInitScript(tier => {
    localStorage.setItem('walnut-todo-active-section', tier);
    localStorage.setItem('walnut-todo-tier-view-modes', JSON.stringify({ [tier]: 'project' }));
  }, tierId);
  await boot(page, baseURL!);
  const zone = page.locator(`[data-drop-zone="${tierId}-drop-zone"]`);
  const labels = zone.locator('.tier-project-label');
  const order = () => labels.evaluateAll(rows => rows.map(row => row.getAttribute('data-project')));
  await expect(labels).toHaveCount(2);
  const initial = await order();
  const first = zone.locator(`[data-project="${initial[0]}"]`);
  const second = zone.locator(`[data-project="${initial[1]}"]`);
  await first.dragTo(second, { targetPosition: { x: 30, y: 6 } });
  await expect.poll(order).toEqual([...initial].reverse());
  const menuButton = first.locator('.navigation-more');
  await menuButton.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByTestId('project-ctx-menu');
  await expect(menu).toBeVisible();
  const trigger = (await menuButton.boundingBox())!, menuBox = (await menu.boundingBox())!;
  expect(menuBox.y).toBeGreaterThan(trigger.y);
  await menu.getByRole('menuitem', { name: 'Move up', exact: true }).click();
  await expect.poll(order).toEqual(initial);
  for (let i = 0; i < tasks.length; i++) {
    const response = await page.request.get(`/api/tasks/${tasks[i]}`);
    expect(response.ok()).toBe(true);
    expect((await response.json()).task.project).toBe(projects[i]);
    await expect(zone.locator(`[data-task-id="${tasks[i]}"]`)).toBeVisible();
  }
  // Leave no custom tier behind: other specs count the tabs on the shared bar.
  for (const id of tasks) await page.request.delete(`/api/tasks/${id}?force=true`).catch(() => {});
  await page.request.delete(`/api/focus/tiers/${tierId}`).catch(() => {});
});

test('navigation undo reports storage failure without silently reverting the order', async ({ page, baseURL }) => {
  await boot(page, baseURL!);
  await page.locator('#home-task-navigation [data-navigation-id="tasks"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
  const before = await page.evaluate(() => localStorage.getItem('walnut-todo-navigation-order'));
  await page.evaluate(() => {
    const own = localStorage.setItem.bind(localStorage);
    const prototype = Storage.prototype.setItem;
    localStorage.setItem = (key, value) => {
      if (key === 'walnut-todo-navigation-order') throw new DOMException('Storage is full', 'QuotaExceededError');
      return own(key, value);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key === 'walnut-todo-navigation-order') throw new DOMException('Storage is full', 'QuotaExceededError');
      return prototype.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Could not restore navigation order', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('walnut-todo-navigation-order'))).toBe(before);
  await page.reload();
  await expect.poll(() => page.locator('#home-task-navigation .navigation-heading.todo-pinned-header').evaluateAll(rows => rows.map(row => row.getAttribute('data-navigation-id')))).toEqual(['tasks', 'pinned']);
});

// C57 / C50 / C20: /tasks keeps its query-only panel, but Status is ONE section there too, in
// the status words, and a Status pick matches the same hit set as the home Status chip.
test('/tasks has one Status section in the status words, matching the home hit set', async ({ page, baseURL }) => {
  const stamp = Date.now();
  const project = `Status Parity ${stamp}`;
  const ids: string[] = [];
  for (const [title, done] of [[`parity open ${stamp}`, false], [`parity doing ${stamp}`, false], [`parity done ${stamp}`, true]] as const) {
    const response = await page.request.post('/api/tasks', { data: { title, project, source: 'local' } });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).task.id as string;
    ids.push(id);
    if (done) expect((await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'COMPLETE' } })).ok()).toBe(true);
  }
  try {
    await boot(page, baseURL!);
    // Home: Status Complete only, in this project.
    await setStatus(page, ['Complete']);
    await page.locator('#home-task-navigation .todo-search-bar input').fill(`parity`);
    const homeRow = (id: string) => page.locator(`#home-task-navigation [data-task-id="${id}"]`).first();
    await expect(homeRow(ids[2])).toBeVisible({ timeout: 15_000 });
    const visibleHome: string[] = [];
    for (const id of ids) if (await homeRow(id).count()) visibleHome.push(id);
    expect(visibleHome).toEqual([ids[2]]);
    await page.locator('#home-task-navigation .todo-search-bar input').fill('');

    await page.locator('.sidebar a[href="/tasks"]').click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByTestId('tasks-table')).toBeVisible({ timeout: 20_000 });
    // MainPage stays mounted (hidden) behind /tasks, so the trigger is scoped to the page.
    await page.locator('.tasks-page button[aria-label="View options"]').click();
    const panel = page.locator('.vd-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-rail-section="q-phase"]')).toHaveCount(0);
    await expect(panel.locator('[data-rail-section="q-status"]')).toHaveCount(1);
    await expect(panel.locator('[data-rail-section="q-status"] .vd-rail-name')).toHaveText('Status');
    await panel.locator('[data-rail-section="q-status"]').click();
    const values = panel.locator('.vd-query .vd-cat[data-filter-value]');
    await expect(values.locator('.vd-cat-name')).toHaveText(['To Do', 'In Progress', 'Need Action', 'Waiting', 'Complete']);
    expect(await panel.innerText()).not.toMatch(/\b(Done|Doing)\b/);
    // The page's default (open work) reads as the four not-complete statuses; make it Complete only.
    for (const value of ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING', 'COMPLETE']) {
      const chip = panel.locator(`.vd-cat[data-filter-value="${value}"]`);
      const pressed = (await chip.getAttribute('aria-pressed')) === 'true';
      if (pressed !== (value === 'COMPLETE')) await chip.click();
    }
    await expect(panel.locator('.vd-cat[aria-pressed="true"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    const tableHits = await page.locator('[data-testid="tasks-table"] .tp-row[data-task-id]').evaluateAll(
      (rows, own) => rows.map((r) => r.getAttribute('data-task-id')!).filter((id) => (own as string[]).includes(id)), ids);
    expect(tableHits).toEqual(visibleHome);
    // The chip strip's remove control is an icon, not a text glyph.
    const chipX = page.locator('.task-filter-chips .usage-chip-x').first();
    await expect(chipX.locator('svg')).toHaveCount(1);
    expect(await page.locator('.task-filter-chips').innerText()).not.toContain('\u00d7');
  } finally {
    for (const id of ids) await page.request.delete(`/api/tasks/${id}`).catch(() => {});
  }
});
