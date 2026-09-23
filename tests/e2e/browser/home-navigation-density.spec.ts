import { test, expect } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';
import { openHome } from './home-navigation-helpers';

test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 });
test.setTimeout(120_000);
const SHOTS = '/tmp/walnut-home-navigation';

test('6481 tasks remain browsable without duplicate pins or expanded project walls', async ({ page, baseURL }) => {
  await isolateUiPrefs(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: 'pw-store-sync-session', locked: false }])));
  const now = new Date().toISOString();
  const tasks = Array.from({ length: 6481 }, (_, i) => ({
    id: i === 6400 ? 'pw-task-store-sync' : `density-${i}`, title: `Review item ${i}: ${'a deliberately long task title '.repeat(i % 6 === 0 ? 4 : 1)}`,
    status: i < 3551 ? 'done' : i < 3752 ? 'in_progress' : 'todo',
    phase: i < 3551 ? 'COMPLETE' : i < 3752 ? 'IN_PROGRESS' : 'TODO',
    priority: 'none', project: i % 61 === 60 ? '' : `Project ${i % 61}`,
    source: 'local', created_at: now, updated_at: now,
    description: '', summary: '', note: '', subtasks: [],
    pinned: i >= 3551 && i < 3651,
    ...(i >= 3551 && i < 3651 ? { focus_tier: ['focus', 'satellite', 'backlog', 'wait'][i % 4] } : {}),
  }));
  await page.route('**/api/tasks?*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/tasks') return route.continue();
    await route.fulfill({ json: { tasks } });
  });
  await page.route('**/api/focus/tasks', route => route.fulfill({ json: {
    pinned_tasks: tasks.filter(t => t.pinned).map(t => t.id),
    focus_tasks: tasks.filter(t => t.focus_tier === 'focus').map(t => t.id),
    satellite_tasks: tasks.filter(t => t.focus_tier === 'satellite').map(t => t.id),
    backlog_tasks: tasks.filter(t => t.focus_tier === 'backlog').map(t => t.id),
    wait_tasks: tasks.filter(t => t.focus_tier === 'wait').map(t => t.id),
  } }));
  const loads: number[] = [];
  for (let round = 0; round < 5; round++) {
    const start = Date.now();
    if (round === 0) await openHome(page, baseURL!); else await page.reload();
    await expect(page.locator('.todo-group-project-header')).toHaveCount(61, { timeout: 45_000 });
    await expect(page.locator('[data-task-id="density-3552"]')).toHaveCount(1);
    loads.push(Date.now() - start);
    expect(await page.locator('.todo-panel-item').count()).toBeLessThan(150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.waitForLoadState('networkidle');
  }
  const firstProject = page.locator('.todo-group-project-header').filter({ hasText: 'Project 1' }).first();
  await firstProject.scrollIntoViewIfNeeded();
  await firstProject.locator('.todo-group-name-btn').click();
  const firstGroup = firstProject.locator('xpath=..');
  await expect(firstGroup.locator('.todo-panel-item').first()).toBeVisible();
  // An open project draws a batch of 30 and a "Show more" row, never its whole wall; each
  // click draws the next batch, and folding starts it over.
  const total = Number(await firstProject.locator('.todo-group-count').innerText());
  expect(total).toBeGreaterThan(40);
  await expect(firstGroup.locator('.todo-panel-item')).toHaveCount(30);
  const showMore = firstGroup.getByRole('button', { name: 'Show more', exact: true });
  await expect(showMore).toHaveAttribute('title', `${total - 30} more tasks`);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dense-projects.png` });
  await showMore.click();
  await expect(firstGroup.locator('.todo-panel-item')).toHaveCount(total);
  await expect(showMore).toHaveCount(0);
  await firstProject.locator('.todo-group-name-btn').click();
  await expect(firstGroup.locator('.todo-panel-item')).toHaveCount(0);
  await firstProject.locator('.todo-group-name-btn').click();
  await expect(firstGroup.locator('.todo-panel-item')).toHaveCount(30);
  await page.reload();
  await expect(page.locator('.todo-group-project').filter({ has: page.locator('.todo-group-project-name', { hasText: /^Project 1$/ }) }).locator('.todo-panel-item').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  // Rows off screen are not rendered yet (content-visibility) and stand at their size
  // estimate. It must equal a rendered row, or the list shifts under the pointer as rows
  // scroll in (WebKit measured 34px unrendered against 28px rendered).
  const rowHeights = await page.locator('#home-task-navigation .todo-group-project .todo-panel-item')
    .evaluateAll(rows => [...new Set(rows.map(row => Math.round(row.getBoundingClientRect().height)))]);
  expect(rowHeights).toEqual([28]);
  const scroller = page.locator('#home-task-navigation .home-navigation-scroll');
  const rect = (await scroller.boundingBox())!;
  await page.mouse.move(rect.x + 30, rect.y + 40);
  await page.mouse.wheel(0, -12_000);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
  await page.locator('.main-page-session-column [data-session-id="pw-store-sync-session"]').getByRole('button', { name: 'Locate task', exact: true }).click();
  const located = page.locator('.todo-panel-list [data-task-id="pw-task-store-sync"]');
  await expect(located).toBeVisible();
  // The located task sits past its project's first batch; the locate draws it anyway.
  expect(await located.evaluate(el => [...el.closest('.todo-group-project')!.querySelectorAll('.todo-panel-item')].indexOf(el))).toBeGreaterThanOrEqual(30);
  await expect.poll(async () => {
    const item = await located.boundingBox(), viewport = await scroller.boundingBox();
    return !!item && !!viewport && item.y >= viewport.y && item.y + item.height <= viewport.y + viewport.height;
  }).toBe(true);
  await expect.poll(() => page.evaluate(() => Number(sessionStorage.getItem('walnut-home-todo-scroll')))).toBeGreaterThan(0);
  // A locate opens the task's project for this visit only; only a click on a project saves it open.
  const opened = await page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-list-opened') ?? '[]'));
  expect(opened).toContain('Project 1');
  expect(opened).not.toContain('Project 56');
  await test.info().attach('load-times', { body: JSON.stringify({ loads, worst: Math.max(...loads) }), contentType: 'application/json' });
  test.info().annotations.push({ type: 'load-times-ms', description: JSON.stringify({ loads, worst: Math.max(...loads) }) });
  expect(errors).toEqual([]);
});

test('a task located deep in a long project is drawn after the first batch, without every row before it', async ({ page, baseURL }) => {
  await isolateUiPrefs(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: 'pw-store-sync-session', locked: false }])));
  const now = new Date().toISOString();
  const tasks = Array.from({ length: 400 }, (_, i) => ({
    id: i === 250 ? 'pw-task-store-sync' : `deep-${i}`, title: `Deep item ${i}`, status: 'todo', phase: 'TODO',
    priority: 'none', project: 'Deep project', source: 'local', created_at: now, updated_at: now,
    description: '', summary: '', note: '', subtasks: [],
  }));
  await page.route('**/api/tasks?*', async route => {
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.continue();
    await route.fulfill({ json: { tasks } });
  });
  await page.route('**/api/focus/tasks', route => route.fulfill({ json: {
    pinned_tasks: [], focus_tasks: [], satellite_tasks: [], backlog_tasks: [], wait_tasks: [],
  } }));
  await openHome(page, baseURL!);
  const header = page.locator('.todo-group-project-header').filter({ has: page.locator('.todo-group-project-name', { hasText: /^Deep project$/ }) });
  const group = header.locator('xpath=..');
  await expect(header).toHaveCount(1, { timeout: 45_000 });
  await expect(group.locator('.todo-panel-item')).toHaveCount(0);
  const drawn = () => group.evaluate(g => [...g.querySelectorAll('.todo-panel-item, .todo-list-show-more')]
    .map(el => el.classList.contains('todo-list-show-more') ? 'more' : el.getAttribute('data-task-id')));
  const firstIds = (n: number) => tasks.slice(0, n).map(t => t.id);

  // Locate: the first batch, the "Show more" row, then the located row on its own.
  await page.locator('.main-page-session-column [data-session-id="pw-store-sync-session"]').getByRole('button', { name: 'Locate task', exact: true }).click();
  const located = group.locator('[data-task-id="pw-task-store-sync"]');
  await expect(located).toBeVisible();
  expect(await drawn()).toEqual([...firstIds(30), 'more', 'pw-task-store-sync']);
  await expect(group.getByRole('button', { name: 'Show more', exact: true })).toHaveAttribute('title', '369 more tasks');
  const scroller = page.locator('#home-task-navigation .home-navigation-scroll');
  await expect.poll(async () => {
    const item = await located.boundingBox(), viewport = await scroller.boundingBox();
    return !!item && !!viewport && item.y >= viewport.y && item.y + item.height <= viewport.y + viewport.height;
  }).toBe(true);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-deep-locate.png` });

  // Focus moving back up keeps the located row where it is.
  await group.locator('[data-task-id="deep-3"] .todo-item-title').click();
  await expect(group.locator('[data-task-id="deep-3"]')).toHaveClass(/task-focused/);
  expect(await drawn()).toEqual([...firstIds(30), 'more', 'pw-task-store-sync']);

  // "Show more" draws the next batch between them.
  await group.getByRole('button', { name: 'Show more', exact: true }).click();
  expect(await drawn()).toEqual([...firstIds(60), 'more', 'pw-task-store-sync']);

  // Folding starts the visit's batch over.
  await header.locator('.todo-group-name-btn').click();
  await expect(group.locator('.todo-panel-item')).toHaveCount(0);
  await header.locator('.todo-group-name-btn').click();
  await expect.poll(drawn).toEqual([...firstIds(30), 'more']);
  expect(errors).toEqual([]);
});
