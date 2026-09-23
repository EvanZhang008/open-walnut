import { test, expect, type Page } from '@playwright/test';
import { isolateUiPrefs, selectProject } from './todo-panel-helpers';
import { arrange, chooseViewOption, homeToolbar, openHome, setShowCompleted } from './home-navigation-helpers';

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
  await project('Navigation Alpha').locator('.todo-group-name-btn').click();
  await expect(project('Navigation Alpha').locator(`[data-task-id="${ids[0]}"]`)).toBeVisible();
  await selectProject(page, 'All');
  await expect(project('Navigation Beta').locator('.todo-panel-item')).toHaveCount(0);
  // The list remembers what the user opened; everything else stays folded.
  const opened = await page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-list-opened') ?? '[]'));
  expect(opened).toContain('Navigation Alpha');
  expect(opened).not.toContain('Navigation Beta');
  await arrange(page, 'Flat');
  await chooseViewOption(page, 'collapse');
  await arrange(page, 'By project');
  await expect(project('Navigation Alpha').locator('.todo-panel-item')).toHaveCount(0);
  await expect(project('Navigation Beta').locator('.todo-panel-item')).toHaveCount(0);
  await chooseViewOption(page, 'collapse');
  await expect(project('Navigation Alpha').locator(`[data-task-id="${ids[0]}"]`)).toBeAttached();
  await expect(project('Navigation Beta').locator(`[data-task-id="${ids[1]}"]`)).toBeAttached();
  await page.reload();
  await expect(homeToolbar(page).getByRole('button', { name: 'View options', exact: true })).toBeVisible({ timeout: 30_000 });
  await setShowCompleted(page, true);
  await expect(project('Navigation Alpha').locator(`[data-task-id="${ids[0]}"]`)).toBeAttached();
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
  const expected = [...before];
  const first = expected.indexOf(ids[0]), last = expected.indexOf(ids[2]);
  [expected[first], expected[last]] = [expected[last], expected[first]];
  await expect.poll(async () => (await (await page.request.get('/api/focus/tasks')).json()).pinned_tasks).toEqual(expected);
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
