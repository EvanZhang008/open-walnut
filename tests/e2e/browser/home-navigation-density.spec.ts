import { test, expect, type Page } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';

test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 });
test.setTimeout(120_000);
const SHOTS = '/tmp/walnut-home-navigation';

async function openHome(page: Page, baseURL: string) {
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await expect(page.locator('.task-view-menu-trigger')).toBeVisible({ timeout: 45_000 });
}

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
  await expect(firstProject.locator('xpath=..').locator('.todo-panel-item').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-dense-projects.png` });
  await page.reload();
  await expect(page.locator('.todo-group-project').filter({ has: page.locator('.todo-group-project-name', { hasText: /^Project 1$/ }) }).locator('.todo-panel-item').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  const scroller = page.locator('#home-task-navigation .home-navigation-scroll');
  const rect = (await scroller.boundingBox())!;
  await page.mouse.move(rect.x + 30, rect.y + 40);
  await page.mouse.wheel(0, -12_000);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
  await page.locator('.main-page-session-column [data-session-id="pw-store-sync-session"]').getByRole('button', { name: 'Locate task', exact: true }).click();
  const located = page.locator('.todo-panel-list [data-task-id="pw-task-store-sync"]');
  await expect(located).toBeVisible();
  await expect.poll(async () => {
    const item = await located.boundingBox(), viewport = await scroller.boundingBox();
    return !!item && !!viewport && item.y >= viewport.y && item.y + item.height <= viewport.y + viewport.height;
  }).toBe(true);
  await expect.poll(() => page.evaluate(() => Number(sessionStorage.getItem('walnut-home-todo-scroll')))).toBeGreaterThan(0);
  await test.info().attach('load-times', { body: JSON.stringify({ loads, worst: Math.max(...loads) }), contentType: 'application/json' });
  test.info().annotations.push({ type: 'load-times-ms', description: JSON.stringify({ loads, worst: Math.max(...loads) }) });
  expect(errors).toEqual([]);
});
