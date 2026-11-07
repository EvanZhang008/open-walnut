import fs from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';
import { keepTaskFramesTo } from './task-list-stub';

const project = `Board acceptance ${Date.now().toString(36)}`;
const made: string[] = [];
const ids = { leader: '', child: '', grandchild: '', crossChild: '', separateChild: '', other: '', spare: '' };
async function create(request: APIRequestContext, title: string, fields: Record<string, unknown> = {}) {
  const response = await request.post('/api/tasks', { data: { title, project, source: 'local', pinned: true, focus_tier: 'focus', ...fields } });
  expect(response.ok(), await response.text()).toBe(true);
  const task = (await response.json()).task;
  made.push(task.id);
  return task.id as string;
}
async function open(page: Page) {
  await isolateUiPrefs(page);
  await page.setContent(`<a href="http://localhost:${process.env.PW_TEST_PORT ?? 3457}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click();
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Open task board', exact: true }).click();
  await expect(page.getByTestId('home-board')).toBeVisible();
  await expect(page.getByTestId('home-board').locator('.home-board-columns')).toBeVisible();
  await page.getByRole('button', { name: 'By pin', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill(project);
}
const card = (page: Page, id: string) => page.locator(`[data-board-task="${id}"]`);
const column = (page: Page, id: string) => page.locator(`[data-board-column="${id}"]`);

test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);
test.beforeAll(async ({ request }) => {
  ids.leader = await create(request, 'Board leader');
  ids.child = await create(request, 'Board child', { parent_task_id: ids.leader });
  ids.grandchild = await create(request, 'Board grandchild', { parent_task_id: ids.child });
  ids.crossChild = await create(request, 'Board cross-project child', { project: `${project} other`, parent_task_id: ids.leader });
  ids.separateChild = await create(request, 'Board separate-tier child', { parent_task_id: ids.leader, focus_tier: 'wait' });
  ids.other = await create(request, 'Board other project', { project: `${project} other` });
  ids.spare = await create(request, 'Board unpinned', { pinned: false, focus_tier: null });
});
test.afterAll(async ({ request }) => { for (const id of made.reverse()) await request.delete(`/api/tasks/${id}?force=true`); });

test('pin columns, project sections, deep family, retained view and popup margins', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const board = page.getByTestId('home-board');
  await expect(column(page, 'focus').locator(`[data-board-project="${project.toLowerCase()}"]`)).toBeVisible();
  await expect(card(page, ids.leader).locator(`[data-board-task="${ids.grandchild}"]`)).toBeVisible();
  await expect(card(page, ids.spare)).toBeVisible();
  const bounds = await board.boundingBox();
  expect(bounds!.x).toBeGreaterThan(0);
  expect(bounds!.y).toBeGreaterThan(0);
  expect(bounds!.x + bounds!.width).toBeLessThan(1280);
  expect(bounds!.y + bounds!.height).toBeLessThan(800);
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill('');
  await board.locator('button').last().focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'By pin', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(board.locator('button').last()).toBeFocused();
  await page.getByRole('button', { name: 'Subtasks of Board leader', exact: true }).click();
  await expect(card(page, ids.child)).toHaveCount(0);
  await page.getByRole('button', { name: 'Close board', exact: true }).click();
  await expect(board).toHaveCount(0);
  await page.getByRole('button', { name: 'Open task board', exact: true }).click();
  await expect(card(page, ids.child)).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill('Board grandchild');
  await expect(card(page, ids.grandchild)).toBeVisible();
  await page.getByRole('button', { name: 'Subtasks of Board leader', exact: true }).click();
  await expect(card(page, ids.grandchild)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Subtasks of Board leader', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Subtasks of Board leader', exact: true }).click();
  await expect(card(page, ids.grandchild)).toBeVisible();
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill('');
  await expect(card(page, ids.child)).toHaveCount(0);
  await page.getByRole('button', { name: 'Subtasks of Board leader', exact: true }).click();
  await page.getByRole('button', { name: 'By status', exact: true }).click();
  await expect(board).toHaveAttribute('data-mode', 'status');
  await expect(board.locator('.home-board-drag')).toHaveCount(0);
  await page.reload();
  await expect(board).toBeVisible();
  await expect(board).toHaveAttribute('data-mode', 'status');
  await page.getByRole('button', { name: 'By pin', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill(project);
  await page.getByRole('button', { name: 'Drag Board leader', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(board.locator('.home-board-drag-preview')).toBeVisible();
  await page.getByTestId('sidebar-org').click();
  await expect(board).toBeHidden();
  expect(await page.evaluate(() => {
    const key = new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true });
    document.dispatchEvent(key);
    return key.defaultPrevented;
  })).toBe(false);
  await page.getByTestId('sidebar-core-app-home').click();
  await expect(board).toBeVisible();
  await expect(board.locator('.home-board-drag-preview')).toHaveCount(0);
  await expect(column(page, 'focus').locator(`[data-board-task="${ids.leader}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true }).click();
  await page.getByTestId('sidebar-org').click();
  await expect(board).toBeHidden();
  await expect(page.getByRole('listbox', { name: 'Move to pin tier' })).toHaveCount(0);
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0);
  await page.getByTestId('sidebar-core-app-home').click();
  await expect(board).toBeVisible();
  await page.getByRole('textbox', { name: 'Search board tasks' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Search board tasks' })).toHaveValue('');
  await expect(board).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(board).toHaveCount(0);
});

test('Move changes the tier for the whole visible family, not project or parent', async ({ page, request }) => {
  await open(page);
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill('Board leader');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/focus/batch', async route => { await held; await route.continue(); });
  await page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true }).click();
  await page.getByRole('option', { name: 'Satellite', exact: true }).click();
  try {
    await expect(column(page, 'satellite').locator(`[data-board-task="${ids.leader}"]`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true })).toBeEnabled();
  await page.unroute('**/api/focus/batch');
  for (const id of [ids.leader, ids.child, ids.grandchild]) {
    await expect.poll(async () => (await (await request.get(`/api/tasks/${id}`)).json()).task.focus_tier ?? 'satellite').toBe('satellite');
    expect((await (await request.get(`/api/tasks/${id}`)).json()).task.project).toBe(project);
  }
  const crossChild = (await (await request.get(`/api/tasks/${ids.crossChild}`)).json()).task;
  expect(crossChild.focus_tier ?? 'satellite').toBe('satellite');
  expect(crossChild.project).toBe(`${project} other`);
  expect(crossChild.parent_task_id).toBe(ids.leader);
  expect((await (await request.get(`/api/tasks/${ids.separateChild}`)).json()).task.focus_tier).toBe('wait');
  expect((await (await request.get(`/api/tasks/${ids.other}`)).json()).task.focus_tier).toBe('focus');
  expect((await (await request.get(`/api/tasks/${ids.child}`)).json()).task.parent_task_id).toBe(ids.leader);
  await page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true }).click();
  await page.getByRole('option', { name: 'Focus', exact: true }).click();
  await expect(column(page, 'focus').locator(`[data-board-task="${ids.leader}"]`)).toBeVisible();
});

test('dragging a child body saves its descendants without moving its leader', async ({ page, request }) => {
  const leader = await create(request, 'Board body leader');
  const child = await create(request, 'Board body child', { parent_task_id: leader });
  const grandchild = await create(request, 'Board body grandchild', { parent_task_id: child });
  await open(page);
  const body = card(page, child).locator(':scope > .home-board-meta > .home-board-state');
  await body.scrollIntoViewIfNeeded();
  await expect(body).toBeInViewport();
  const start = (await body.boundingBox())!;
  expect(await body.evaluate(el => { const box = el.getBoundingClientRect(); return document.elementFromPoint(box.x + 5, box.y + box.height / 2)?.closest('[data-board-task]')?.getAttribute('data-board-task'); })).toBe(child);
  const end = (await column(page, 'satellite').locator('h2').boundingBox())!;
  await page.mouse.move(start.x + 5, start.y + start.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(start.x + 25, start.y + start.height / 2, { steps: 4 });
    await expect(page.getByTestId('home-board').locator('.home-board-drag-preview')).toHaveText('Board body child');
    await page.mouse.move(end.x + 35, end.y + 70, { steps: 12 });
  } finally { await page.mouse.up(); }
  for (const id of [child, grandchild]) await expect.poll(async () => (await (await request.get(`/api/tasks/${id}`)).json()).task.focus_tier ?? 'satellite').toBe('satellite');
  expect((await (await request.get(`/api/tasks/${leader}`)).json()).task.focus_tier).toBe('focus');
  expect((await (await request.get(`/api/tasks/${child}`)).json()).task.parent_task_id).toBe(leader);
  await expect(column(page, 'satellite').locator(`[data-board-task="${child}"]`)).toBeVisible();
});

test('drag, failed write recovery in quiet mode, unpinned move, empty search and narrow theme', async ({ page, request }) => {
  await page.route('**/api/quiet', route => route.fulfill({ json: { active: true, allowPermissions: false, holds: [{ source: 'user', since: Date.now(), reason: 'Focus' }] } }));
  await open(page);
  const handle = page.getByRole('button', { name: 'Drag Board leader', exact: true });
  const start = await handle.boundingBox();
  const end = await column(page, 'satellite').locator('h2').boundingBox();
  const board = page.getByTestId('home-board');
  const strip = board.locator('.home-board-columns');
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(board).toBeVisible();
  await expect(board.locator('.home-board-drag-preview')).toHaveCount(0);
  let writes = 0;
  page.on('request', r => { if (r.url().endsWith('/api/focus/batch') && r.method() === 'POST') writes++; });
  for (const focusInside of [true, false]) {
    if (focusInside) await page.getByRole('button', { name: 'Close board', exact: true }).focus();
    else await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
    await page.mouse.down();
    await page.mouse.move(start!.x + start!.width / 2 + 12, start!.y + start!.height / 2 + 8, { steps: 4 });
    await expect(board.locator('.home-board-drag-preview')).toBeVisible();
    await page.waitForTimeout(2500);
    expect(await strip.evaluate(el => el.scrollLeft)).toBe(0);
    await page.mouse.move(end!.x + 35, end!.y + 70, { steps: 15 });
    await page.keyboard.press('Escape');
    await expect(board.locator('.home-board-drag-preview')).toHaveCount(0);
    await page.mouse.up();
    await expect(board).toBeVisible();
    await expect(column(page, 'focus').locator(`[data-board-task="${ids.leader}"]`)).toBeVisible();
    expect((await (await request.get(`/api/tasks/${ids.leader}`)).json()).task.focus_tier).toBe('focus');
    expect(writes).toBe(0);
  }
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(start!.x + start!.width / 2 + 12, start!.y + start!.height / 2 + 8, { steps: 4 });
  await page.mouse.move(end!.x + 35, end!.y + 70, { steps: 15 });
  await page.mouse.up();
  await expect(column(page, 'satellite').locator(`[data-board-task="${ids.leader}"]`)).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.leader}`)).json()).task.focus_tier ?? 'satellite').toBe('satellite');
  const beforeErrorTop = (await strip.boundingBox())!.y;
  await page.route('**/api/focus/batch', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled refusal' }) }));
  await page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true }).click();
  let releaseRollback!: () => void;
  const rollback = new Promise<void>(resolve => { releaseRollback = resolve; });
  await page.route('**/api/focus/tasks', async route => {
    const response = await route.fetch();
    const json = await response.json();
    await rollback;
    await route.fulfill({ response, json });
  });
  await page.getByRole('option', { name: 'Focus', exact: true }).click();
  try {
    await expect(page.getByTestId('home-board').getByRole('alert')).toBeVisible();
    expect((await strip.boundingBox())!.y).toBe(beforeErrorTop);
    await page.waitForTimeout(6500);
    await expect(page.getByTestId('home-board').getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true })).toBeEnabled();
    await expect(board.locator('.home-board-hint')).not.toContainText('Saving pin tier');
    await page.unroute('**/api/focus/batch');
    await board.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(column(page, 'focus').locator(`[data-board-task="${ids.leader}"]`)).toBeVisible();
    await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.leader}`)).json()).task.focus_tier).toBe('focus');
  } finally { releaseRollback(); }
  await page.waitForTimeout(1000);
  await expect(column(page, 'focus').locator(`[data-board-task="${ids.leader}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true }).click();
  await page.getByRole('option', { name: 'Satellite', exact: true }).click();
  await expect(column(page, 'satellite').locator(`[data-board-task="${ids.leader}"]`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true })).toBeEnabled();
  await page.unroute('**/api/focus/tasks');
  await page.route('**/api/focus/batch', route => route.fulfill({ status: 400, json: { error: 'Controlled refusal' } }));
  await page.route('**/api/focus/tasks', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled read failure' }) }));
  await page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true }).click();
  await page.getByRole('option', { name: 'Focus', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true })).toBeEnabled();
  await expect(column(page, 'satellite').locator(`[data-board-task="${ids.leader}"]`)).toBeVisible();
  expect((await (await request.get(`/api/tasks/${ids.leader}`)).json()).task.focus_tier ?? 'satellite').toBe('satellite');
  await expect(board.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/focus/tasks');
  await page.unroute('**/api/focus/batch');
  await page.getByTestId('home-board').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(column(page, 'focus').locator(`[data-board-task="${ids.leader}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Move Board unpinned to pin tier', exact: true }).click();
  await page.getByRole('option', { name: 'Focus', exact: true }).click();
  await expect(column(page, 'focus').locator(`[data-board-task="${ids.spare}"]`)).toBeVisible();
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill('no such board task');
  await expect(page.getByTestId('home-board').locator('[data-board-task]')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill(project);
  await page.getByRole('button', { name: 'Move Board leader to pin tier', exact: true }).click();
  const menu = page.getByRole('listbox', { name: 'Move to pin tier' });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Move to pin tier' })).toHaveCount(0);
  await expect(page.getByTestId('home-board')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole('button', { name: 'Close board', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open task board', exact: true })).toBeVisible();
  await expect(page.locator('.todo-panel-hide')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open task board', exact: true }).click();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const box = await page.getByTestId('home-board').boundingBox();
  expect(box!.x + box!.width).toBeLessThan(390);
  const dir = '/tmp/home-board-tests';
  fs.mkdirSync(dir, { recursive: true });
  await page.getByTestId('home-board').screenshot({ path: `${dir}/narrow-${test.info().project.name}.png` });
});

test('late move failures cannot cross a close, reopen or read-only mode change', async ({ page, request }) => {
  const id = await create(request, 'Board lifecycle leader');
  await open(page);
  const board = page.getByTestId('home-board');
  let posts = 0;
  for (const transition of ['reopen', 'status'] as const) {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/focus/batch', async route => {
      posts++;
      await held;
      await route.fulfill({ status: 400, json: { error: 'Controlled late refusal' } });
    });
    try {
      const before = posts;
      await board.getByRole('button', { name: 'Move Board lifecycle leader to pin tier', exact: true }).click();
      await page.getByRole('option', { name: 'Satellite', exact: true }).click();
      await expect.poll(() => posts).toBe(before + 1);
      if (transition === 'reopen') {
        await board.getByRole('button', { name: 'Close board', exact: true }).click();
        await page.getByRole('button', { name: 'Open task board', exact: true }).click();
        await board.getByRole('textbox', { name: 'Search board tasks' }).fill(project);
      } else {
        await board.getByRole('button', { name: 'By status', exact: true }).click();
        await expect(board.locator('.home-board-meta > button')).toHaveCount(0);
      }
      release();
      await expect(board.locator('.home-board-hint')).not.toContainText('Saving pin tier');
      await expect(board.getByRole('alert')).toHaveCount(0);
      await expect(board.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
      expect(posts).toBe(before + 1);
      await board.getByRole('button', { name: 'By pin', exact: true }).click();
      await expect(board.getByRole('button', { name: 'Move Board lifecycle leader to pin tier', exact: true })).toBeEnabled();
      await expect(column(page, 'focus').locator(`[data-board-task="${id}"]`)).toBeVisible();
      expect((await (await request.get(`/api/tasks/${id}`)).json()).task.focus_tier).toBe('focus');
    } finally {
      release();
      await page.unroute('**/api/focus/batch');
    }
  }
  await page.route('**/api/focus/batch', route => { posts++; return route.fulfill({ status: 400, json: { error: 'Controlled refusal' } }); });
  try {
    await board.getByRole('button', { name: 'Move Board lifecycle leader to pin tier', exact: true }).click();
    await page.getByRole('option', { name: 'Satellite', exact: true }).click();
    await expect(board.getByRole('alert')).toBeVisible();
    const before = posts;
    await board.getByRole('button', { name: 'By status', exact: true }).click();
    await expect(board.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await expect(board.getByRole('alert')).toHaveCount(0);
    expect(posts).toBe(before);
  } finally { await page.unroute('**/api/focus/batch'); }
});

test('moving into a dense offscreen column reveals the task inside a folded family', async ({ page, request }) => {
  test.setTimeout(150_000);
  const visibilityProject = `${project} visibility`;
  for (let i = 0; i < 28; i++) await create(request, `Board visibility filler ${i}`, { project: visibilityProject, focus_tier: 'satellite' });
  const parent = await create(request, 'Board visibility parent', { project: visibilityProject, focus_tier: 'satellite' });
  const sibling = await create(request, 'Board visibility sibling', { project: visibilityProject, focus_tier: 'satellite', parent_task_id: parent });
  const child = await create(request, 'Board visibility child', { project: visibilityProject, parent_task_id: parent });
  const grandchild = await create(request, 'Board visibility grandchild', { project: visibilityProject, parent_task_id: child });
  await page.setViewportSize({ width: 700, height: 800 });
  await open(page);
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill(visibilityProject);
  await page.getByRole('button', { name: 'Subtasks of Board visibility parent', exact: true }).click();
  await expect(card(page, sibling)).toHaveCount(0);
  await page.getByRole('button', { name: 'Move Board visibility child to pin tier', exact: true }).click();
  await page.getByRole('option', { name: 'Satellite', exact: true }).click();
  await expect(card(page, parent).locator(`[data-board-task="${child}"]`)).toBeAttached();
  await expect(card(page, child).locator(`[data-board-task="${grandchild}"]`)).toBeAttached();
  await expect.poll(() => card(page, child).locator('.home-board-title').first().evaluate(el => {
    const title = el.getBoundingClientRect();
    const col = el.closest('[data-board-column]')!;
    const body = col.querySelector('.home-board-column-body')!.getBoundingClientRect();
    const head = col.querySelector('header')!.getBoundingClientRect();
    const strip = el.closest('.home-board-columns')!.getBoundingClientRect();
    return title.top >= Math.max(body.top, head.bottom) && title.bottom <= body.bottom && title.left >= strip.left && title.right <= strip.right;
  })).toBe(true);
  for (const id of [child, grandchild]) {
    const task = (await (await request.get(`/api/tasks/${id}`)).json()).task;
    expect(task.focus_tier ?? 'satellite').toBe('satellite');
    expect(task.project).toBe(visibilityProject);
  }
  expect((await (await request.get(`/api/tasks/${child}`)).json()).task.parent_task_id).toBe(parent);
  await page.getByRole('button', { name: 'Close board', exact: true }).click();
  await page.getByRole('button', { name: 'Open task board', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill(visibilityProject);
  await expect(card(page, child)).toBeAttached();
  const longTitle = `Board oversized title ${'readable '.repeat(100)}`;
  const tall = await create(request, longTitle, { project: visibilityProject });
  await page.setViewportSize({ width: 250, height: 450 });
  await card(page, tall).getByRole('button', { name: `Move ${longTitle} to pin tier`, exact: true }).click();
  await page.getByRole('option', { name: 'Satellite', exact: true }).click();
  await expect.poll(() => card(page, tall).locator('.home-board-title').evaluate(el => {
    const title = el.getBoundingClientRect(), col = el.closest('[data-board-column]')!;
    const body = col.querySelector('.home-board-column-body')!.getBoundingClientRect();
    const head = col.querySelector('header')!.getBoundingClientRect(), strip = el.closest('.home-board-columns')!.getBoundingClientRect();
    return title.top >= Math.max(body.top, head.bottom) && title.top < body.bottom && title.left >= strip.left && title.left < strip.right;
  })).toBe(true);
});

test('retrying a filtered descendant does not leave a delayed scroll target', async ({ page, request }) => {
  const filteredProject = `${project} filtered visibility`;
  for (let i = 0; i < 28; i++) await create(request, `Board filtered filler ${i}`, { project: filteredProject, focus_tier: 'satellite' });
  const leader = await create(request, 'Board filtered leader', { project: filteredProject });
  const child = await create(request, 'Board filtered descendant', { project: filteredProject, parent_task_id: leader });
  await open(page);
  const board = page.getByTestId('home-board');
  await board.getByRole('textbox', { name: 'Search board tasks' }).fill('Board filtered leader');
  await page.route('**/api/focus/batch', async route => {
    const data = route.request().postDataJSON();
    const response = await request.post('/api/focus/batch', { data: { ...data, task_ids: [leader] } });
    const json = await response.json();
    await route.fulfill({ json: { ...json, failed: [{ id: child, error: 'Controlled refusal' }] } });
  });
  await board.getByRole('button', { name: 'Move Board filtered leader to pin tier', exact: true }).click();
  await page.getByRole('option', { name: 'Satellite', exact: true }).click();
  await expect(board.getByRole('alert')).toContainText('Board filtered descendant');
  await page.unroute('**/api/focus/batch');
  await column(page, 'satellite').locator('.home-board-column-body').evaluate(el => { el.scrollTop = 0; });
  await board.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(board.getByRole('alert')).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`/api/tasks/${child}`)).json()).task.focus_tier ?? 'satellite').toBe('satellite');
  await board.getByRole('textbox', { name: 'Search board tasks' }).fill('');
  await expect(card(page, child)).toBeAttached();
  expect(await card(page, child).evaluate(el => el.getBoundingClientRect().top > el.closest('[data-board-column]')!.querySelector('.home-board-column-body')!.getBoundingClientRect().bottom)).toBe(true);
  expect(await column(page, 'satellite').locator('.home-board-column-body').evaluate(el => el.scrollTop)).toBe(0);
});

test('partial batch failure keeps saved successes and reports the refused descendant', async ({ page, request }) => {
  const leader = await create(request, 'Board partial leader');
  const child = await create(request, 'Board partial child', { parent_task_id: leader });
  await open(page);
  await page.route('**/api/focus/batch', async route => {
    expect((await request.delete(`/api/tasks/${child}?force=true`)).ok()).toBe(true);
    await route.continue();
  });
  await page.getByRole('button', { name: 'Move Board partial leader to pin tier', exact: true }).click();
  await page.getByRole('option', { name: 'Satellite', exact: true }).click();
  await expect(page.getByTestId('home-board').getByRole('alert')).toContainText('1 of 2 tasks');
  await expect(page.getByTestId('home-board').getByRole('alert')).toContainText('Board partial child');
  await expect(column(page, 'satellite').locator(`[data-board-task="${leader}"]`)).toBeVisible();
  expect((await (await request.get(`/api/tasks/${leader}`)).json()).task.focus_tier ?? 'satellite').toBe('satellite');
  await page.unroute('**/api/focus/batch');
  await page.getByRole('button', { name: 'Move Board partial leader to pin tier', exact: true }).click();
  await page.getByRole('option', { name: 'Focus', exact: true }).click();
  await expect(column(page, 'focus').locator(`[data-board-task="${leader}"]`)).toBeVisible();
  await expect(page.getByTestId('home-board').getByRole('alert')).toHaveCount(0);
});

test('completed totals stay stable when the archive contains hidden organization nodes', async ({ page, request }) => {
  const archived: string[] = [];
  for (let i = 0; i < 32; i++) {
    const id = await create(request, `Board archive ${i}`, { pinned: false, focus_tier: null });
    archived.push(id);
    expect((await request.patch(`/api/tasks/${id}`, { data: { phase: 'COMPLETE' } })).ok()).toBe(true);
  }
  for (const org_role of ['main', 'lead']) {
    const id = await create(request, `Board archive hidden ${org_role}`, { pinned: false, focus_tier: null, org_role });
    archived.push(id);
    expect((await request.patch(`/api/tasks/${id}`, { data: { phase: 'COMPLETE' } })).ok()).toBe(true);
    expect((await (await request.get(`/api/tasks/${id}`)).json()).task.org_role).toBe(org_role);
  }
  // The fixture server is shared, and the other workers create, complete and delete tasks all
  // the time: a list read now and the board's own load (or its Show more load) a moment later
  // differ by their work (CI 2026-11-06: 118 against 117, 243 tasks against 244). So the test
  // takes one picture of the server that holds still (two archive reads that agree, with the
  // full list read between them) and the board's list requests are answered from it.
  type Row = { id: string; phase: string; status: string; org_role?: string; plugin_only?: string };
  type Page_ = { tasks: Row[]; completedHidden?: number };
  const read = async (archive: boolean): Promise<Page_> =>
    (await request.get(`/api/tasks?fields=list${archive ? '&completedWithinDays=0' : ''}`)).json();
  const shape = (p: Page_) => JSON.stringify([p.completedHidden, p.tasks.map(t => [t.id, t.phase, t.status, t.org_role ?? '', t.plugin_only ?? ''])]);
  let archivePage: Page_ | null = null;
  let fullPage: Page_ | null = null;
  for (let i = 0; i < 20 && !archivePage; i++) {
    const a = await read(true);
    const full = await read(false);
    if (shape(a) === shape(await read(true))) { archivePage = a; fullPage = full; }
  }
  expect(archivePage, 'the shared server never held still for one archive read and the next').not.toBeNull();
  expect(archivePage!.completedHidden).toBeGreaterThanOrEqual(32);
  // The board shows the lists this route answers and nothing else: every task of this test exists
  // before the board loads, so no task frame passes (a frame about a task in the picture, another
  // worker deleting its own say, would move the counts away from it mid-test).
  await keepTaskFramesTo(page, new Set());
  await page.route('**/api/tasks?*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/tasks' || url.searchParams.get('fields') !== 'list') return route.continue();
    await route.fulfill({ json: url.searchParams.has('completedWithinDays') ? archivePage : fullPage });
  });
  await open(page);
  await page.getByRole('textbox', { name: 'Search board tasks' }).fill('');
  const visible = fullPage!.tasks.filter(t => !['main', 'lead'].includes(t.org_role ?? '') && !t.plugin_only);
  const expected = visible.filter(t => t.phase === 'COMPLETE' || t.status === 'done').length;
  const expectedOpen = visible.length - expected;
  const openCount = `${expectedOpen} open ${expectedOpen === 1 ? 'task' : 'tasks'}`;
  await expect(page.locator('.home-board-count')).toHaveText(openCount);
  await page.getByRole('button', { name: 'By status', exact: true }).click();
  const doneCount = column(page, 'done').locator('.home-board-column-head > span');
  // The server's hidden count, which leaves the organization nodes out, matches the full list.
  await expect(doneCount).toHaveText(String(expected));
  await expect(page.locator('.home-board-count')).toHaveText(`${openCount} · ${expected} completed`);
  const before = await doneCount.textContent();
  const total = await page.locator('.home-board-count').textContent();
  await column(page, 'done').getByRole('button', { name: 'Show more completed tasks', exact: true }).click();
  await expect(column(page, 'done').locator('[data-board-task]')).toHaveCount(Math.min(60, expected));
  await expect(doneCount).toHaveText(before!);
  await expect(page.locator('.home-board-count')).toHaveText(total!);
  for (const id of archived) expect((await request.delete(`/api/tasks/${id}?force=true`)).ok()).toBe(true);
});

test('custom tiers, live completion, completed batches and opening a task', async ({ page, request }) => {
  test.setTimeout(120_000);
  const tierResponse = await request.post('/api/focus/tiers', { data: { label: `Release ${project}` } });
  expect(tierResponse.ok()).toBe(true);
  const custom = (await tierResponse.json()).tier;
  try {
    const completed: string[] = [];
    for (let i = 0; i < 31; i++) {
      const id = await create(request, `Board completed ${i}`, { pinned: false, focus_tier: null });
      const done = await request.patch(`/api/tasks/${id}`, { data: { phase: 'COMPLETE' } });
      expect(done.ok()).toBe(true);
      completed.push(id);
    }
    await open(page);
    await page.getByRole('button', { name: 'Move Board unpinned to pin tier', exact: true }).click();
    await page.getByRole('option', { name: custom.label, exact: true }).click();
    await expect(column(page, custom.id).locator(`[data-board-task="${ids.spare}"]`)).toBeVisible();
    await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.spare}`)).json()).task.focus_tier).toBe(custom.id);
    await request.patch(`/api/tasks/${ids.spare}`, { data: { phase: 'COMPLETE' } });
    await expect(card(page, ids.spare)).toHaveCount(0);
    await page.getByRole('button', { name: 'By status', exact: true }).click();
    await expect(column(page, 'done').locator('[data-board-task]')).toHaveCount(30);
    await column(page, 'done').getByRole('button', { name: 'Show more completed tasks', exact: true }).click();
    await expect(column(page, 'done').locator('[data-board-task]')).toHaveCount(32);
    await page.getByRole('textbox', { name: 'Search board tasks' }).fill('Board completed 0');
    await expect(card(page, completed[0])).toBeVisible();
    await page.getByRole('textbox', { name: 'Search board tasks' }).fill('Board leader');
    await card(page, ids.leader).getByRole('button', { name: 'Board leader', exact: true }).click();
    await expect(page.getByTestId('home-board')).toHaveCount(0);
    await expect(page.locator(`.todo-detail-pane[data-task-id="${ids.leader}"]`)).toBeVisible();
  } finally { await request.delete(`/api/focus/tiers/${custom.id}`); }
});
