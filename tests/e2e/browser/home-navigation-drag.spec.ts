import { test, expect, type Locator, type Page } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';

test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 });
test.setTimeout(120_000);
const SHOTS = '/tmp/walnut-home-navigation';

async function drag(page: Page, source: Locator, target: Locator, cancel = false) {
  await source.scrollIntoViewIfNeeded();
  const start = await source.boundingBox();
  if (!start) throw new Error('Drag source must be visible');
  await page.mouse.move(start.x + start.width * 0.4, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width * 0.4 + 12, start.y + start.height / 2, { steps: 4 });
  const scroller = page.locator('#home-task-navigation .home-navigation-scroll');
  for (let round = 0; round < 12; round++) {
    const end = await target.boundingBox(), viewport = await scroller.boundingBox();
    if (!end || !viewport) throw new Error('Drop target disappeared');
    if (end.y >= viewport.y + 20 && end.y + end.height <= viewport.y + viewport.height - 20) break;
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    const delta = end.y < viewport.y + 20 ? -180 : 180;
    const before = await scroller.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, delta);
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).not.toBe(before);
  }
  const end = await target.boundingBox();
  if (!end) throw new Error('Drop target disappeared');
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 16 });
  for (let step = 0; step < 5; step++) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const current = await target.boundingBox();
    if (!current) throw new Error('Drop target disappeared during drag');
    await page.mouse.move(current.x + current.width / 2, current.y + current.height / 2, { steps: 4 });
  }
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}

test('native reorder, drag cancellation, folded tiers, failure recovery and explicit unpin', async ({ page, baseURL }) => {
  await isolateUiPrefs(page);
  await page.addInitScript(() => {
    if (localStorage.getItem('walnut-todo-collapsed-sections') === null) localStorage.setItem('walnut-todo-collapsed-sections', '[]');
    if (localStorage.getItem('walnut-todo-collapsed-projs') === null) localStorage.setItem('walnut-todo-collapsed-projs', '[]');
  });
  const ids: string[] = [];
  for (const [i, tier] of ['focus', 'focus', 'satellite'].entries()) {
    const res = await page.request.post('/api/tasks', { data: { title: `Navigation drag ${i}`, project: i === 2 ? 'Other project' : 'Navigation project', source: 'local' } });
    expect(res.ok()).toBe(true);
    const id = (await res.json()).task.id;
    ids.push(id);
    expect((await page.request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true);
    expect((await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier } })).ok()).toBe(true);
  }
  const group = await page.request.post('/api/tasks/groups', { data: { task_ids: ids.slice(0, 2), label: 'Navigation folder' } });
  expect(group.ok()).toBe(true);
  const groupId = (await group.json()).group_id;
  const ordering = (await (await page.request.get('/api/ordering')).json()).separators ?? [];
  const separatorId = `sep_navigation_${test.info().project.name}_${test.info().repeatEachIndex}`;
  expect((await page.request.put('/api/ordering/separators', { data: { separators: [...ordering, { id: separatorId, tier: 'focus', mode: 'custom', before: ids[0] }] } })).ok()).toBe(true);
  await page.addInitScript(() => localStorage.setItem('walnut-todo-tier-view-modes', JSON.stringify({ focus: 'custom' })));
  const unpins: string[] = [];
  page.on('request', request => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/focus/tasks/${ids[0]}`) unpins.push(request.url());
  });
  const stored = async () => {
    const res = await page.request.get(`/api/tasks/${ids[0]}`);
    expect(res.ok()).toBe(true);
    const task = (await res.json()).task;
    return { pinned: !!task.pinned, tier: task.focus_tier ?? 'satellite', project: task.project };
  };
  const expectTier = async (tier: string) => {
    await expect.poll(stored).toEqual({ pinned: true, tier, project: 'Navigation project' });
    expect(unpins).toEqual([]);
  };
  await page.setContent(`<a href="${baseURL}">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  const root = page.locator('#home-task-navigation');
  const heading = (id: string) => root.locator(`[data-navigation-id="${id}"]`);
  await expect(heading('focus')).toBeVisible({ timeout: 45_000 });
  for (const id of ids) await expect(root.locator(`.todo-pinned-section [data-task-id="${id}"]`)).toBeVisible();
  await heading('satellite').locator('.navigation-heading-open').dragTo(heading('focus'));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-tier-order') ?? '[]')[0])).toBe('satellite');
  await expect(heading('satellite').locator('.navigation-heading-open')).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('walnut-todo-tier-order') ?? '[]')[0])).toBe('focus');
  const card = () => root.locator(`.todo-pinned-section [data-task-id="${ids[0]}"]`);
  const satellite = heading('satellite');
  await expect(card()).toBeVisible();
  await expect(card().locator('.todo-pinned-drag-handle')).toHaveCount(0);
  await drag(page, card(), satellite, true);
  await expectTier('focus');
  let releaseSnapshots!: () => void;
  const snapshotsReleased = new Promise<void>(resolve => { releaseSnapshots = resolve; });
  const staleSnapshots: Promise<void>[] = [];
  const listEndpoint = '**/api/tasks?fields=list';
  await page.route(listEndpoint, async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.tasks.find((task: { id: string; focus_tier?: string }) => task.id === ids[0])?.focus_tier === 'focus') {
      const pending = snapshotsReleased.then(() => route.fulfill({ response }));
      staleSnapshots.push(pending);
      await pending;
    } else await route.fulfill({ response });
  });
  try {
    await drag(page, card(), satellite);
    await expectTier('satellite');
    await expect.poll(() => staleSnapshots.length).toBeGreaterThan(0);
    await expect(root.locator(`[data-drop-zone="satellite-drop-zone"] [data-task-id="${ids[0]}"]`)).toBeVisible();
  } finally {
    releaseSnapshots();
    await Promise.all(staleSnapshots);
    await page.unroute(listEndpoint);
  }
  await page.waitForLoadState('networkidle');
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${ids[0]}`)).json()).task.group_id ?? null).toBeNull();
  expect((await (await page.request.get(`/api/tasks/${ids[1]}`)).json()).task.group_id).toBe(groupId);
  const separators = (await (await page.request.get('/api/ordering')).json()).separators;
  const separator = separators.find((item: { id: string }) => item.id === separatorId);
  expect(separator.tier).toBe('focus');
  expect(separator.before).not.toBe(ids[0]);
  expect(separator.after).not.toBe(ids[0]);
  await expect(root.locator(`[data-drop-zone="satellite-drop-zone"] [data-task-id="${ids[0]}"]`)).toBeVisible();
  await expect(page.locator('.task-detail-modal')).toHaveCount(0);
  await page.route(`**/api/focus/tasks/${ids[0]}/tier`, route => route.fulfill({ status: 503, json: { error: 'Temporary tier failure' } }));
  await drag(page, card(), heading('focus'));
  await expect(page.getByText('Could not move the task to that group. Please try again.', { exact: true }).first()).toBeVisible();
  await expect(root.locator(`[data-drop-zone="satellite-drop-zone"] [data-task-id="${ids[0]}"]`)).toBeVisible();
  await expectTier('satellite');
  await page.unroute(`**/api/focus/tasks/${ids[0]}/tier`);
  await drag(page, card(), heading('focus'));
  await expectTier('focus');
  await heading('backlog').locator('.navigation-heading-open').click();
  await drag(page, card(), heading('backlog'));
  await expectTier('backlog');
  await expect(heading('backlog').locator('.navigation-heading-open')).toHaveAttribute('aria-expanded', 'true');
  const createdTier = await page.request.post('/api/focus/tiers', { data: { label: `Custom ${test.info().project.name} ${test.info().repeatEachIndex}` } });
  expect(createdTier.ok()).toBe(true);
  const customId = (await createdTier.json()).tier.id;
  await expect(heading(customId)).toBeVisible();
  await heading(customId).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New task', exact: true }).click();
  const customGroup = heading(customId).locator('xpath=../..');
  await customGroup.locator('.focus-inline-add input').fill('Custom navigation task');
  await customGroup.locator('.focus-inline-add input').press('Enter');
  await expect(customGroup.locator('[data-task-id]')).toContainText('Custom navigation task');
  await page.reload();
  await expect(heading(customId)).toBeVisible({ timeout: 30_000 });
  await expect(root.locator(`[data-drop-zone="${customId}-drop-zone"]`)).toContainText('Custom navigation task');
  await expectTier('backlog');
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-drag-final.png` });
  await card().scrollIntoViewIfNeeded();
  const box = (await card().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2, { steps: 4 });
  const strip = page.locator('.todo-unpin-zone');
  await expect(strip).toBeVisible();
  const zone = (await strip.boundingBox())!;
  expect(zone.y + zone.height).toBeLessThanOrEqual(840);
  await page.mouse.move(zone.x + 2, zone.y + zone.height - 2, { steps: 16 });
  await expect(strip).toHaveClass(/todo-unpin-zone-hot/);
  await page.mouse.up();
  await expect.poll(async () => (await stored()).pinned).toBe(false);
  expect(unpins).toHaveLength(1);
});
