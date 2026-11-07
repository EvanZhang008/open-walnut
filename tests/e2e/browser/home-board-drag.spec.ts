import { expect, test } from '@playwright/test';
import { loadHome } from './draft-helpers';
import { isolateUiPrefs } from './todo-panel-helpers';
import { answerTaskList } from './task-list-stub';

test('drag preview preserves the grabbed point and drops in the column under the pointer', async ({ page }) => {
  test.setTimeout(120_000);
  const now = new Date().toISOString();
  const rows = Array.from({ length: 152 }, (_, i) => ({
    id: `board-pointer-${i}`, title: `Board pointer task ${i}`, project: `Board pointer project ${i % 9}`,
    source: 'local', category: '', status: 'todo', phase: 'TODO', priority: 'none', created_at: now, updated_at: now,
    pinned: i % 5 !== 4, focus_tier: ['focus', 'satellite', 'wait', 'ct_pointer', null][i % 5],
  }));
  await answerTaskList(page, () => rows);
  await page.route('**/api/focus/tiers', route => route.fulfill({ json: { tiers: [{ id: 'ct_pointer', label: 'Release' }] } }));
  await page.route('**/api/focus/tasks', route => route.fulfill({ json: {
    pinned_tasks: rows.filter(t => t.pinned).map(t => t.id),
    focus_tasks: rows.filter(t => t.focus_tier === 'focus').map(t => t.id),
    satellite_tasks: rows.filter(t => t.focus_tier === 'satellite').map(t => t.id),
    wait_tasks: rows.filter(t => t.focus_tier === 'wait').map(t => t.id),
    custom_tier_tasks: { ct_pointer: rows.filter(t => t.focus_tier === 'ct_pointer').map(t => t.id) },
  } }));
  await page.route('**/api/focus/batch', async route => {
    const body = route.request().postDataJSON();
    for (const row of rows) if (body.task_ids.includes(row.id)) row.focus_tier = body.tier;
    await route.fulfill({ json: { changed: body.task_ids, failed: [] } });
  });
  await isolateUiPrefs(page);
  await page.setViewportSize({ width: 2327, height: 1252 });
  await loadHome(page);
  await page.getByRole('button', { name: 'Open task board', exact: true }).click();
  const board = page.getByTestId('home-board');
  for (const width of [2327, 1000]) {
    await page.setViewportSize({ width, height: 800 });
    const strip = board.locator('.home-board-columns');
    await strip.evaluate(el => { el.scrollLeft = 0; });
    const source = board.locator('[data-board-task="board-pointer-0"]');
    const handle = source.getByRole('button', { name: 'Drag Board pointer task 0', exact: true });
    const sourceBox = (await source.boundingBox())!;
    const grabBox = (await handle.boundingBox())!;
    const grab = { x: grabBox.x + grabBox.width / 2, y: grabBox.y + grabBox.height / 2 };
    const offset = { x: grab.x - sourceBox.x, y: grab.y - sourceBox.y };
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    try {
      await page.mouse.move(grab.x + 12, grab.y + 8, { steps: 3 });
      const preview = board.locator('.home-board-drag-preview');
      await expect(preview).toBeVisible();
      for (const fraction of [0, .5, 1, 0]) {
        await strip.evaluate((el, n) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) * n; }, fraction);
        const column = board.locator('[data-board-column="satellite"]');
        const target = (await column.boundingBox())!;
        const area = (await strip.boundingBox())!;
        const pointer = { x: Math.max(area.x + 30, Math.min(area.x + area.width - 30, target.x + target.width / 2)), y: target.y + 120 };
        await page.mouse.move(pointer.x, pointer.y, { steps: 5 });
        const box = (await preview.boundingBox())!;
        expect(Math.abs(box.x + offset.x - pointer.x)).toBeLessThan(2);
        expect(Math.abs(box.y + offset.y - pointer.y)).toBeLessThan(2);
        expect(pointer.x).toBeGreaterThanOrEqual(box.x);
        expect(pointer.x).toBeLessThanOrEqual(box.x + box.width);
        expect(pointer.y).toBeGreaterThanOrEqual(box.y);
        expect(pointer.y).toBeLessThanOrEqual(box.y + box.height);
      }
      await page.mouse.up();
      await expect(board.locator('[data-board-column="satellite"] [data-board-task="board-pointer-0"]')).toBeAttached();
    } finally {
      if (await board.locator('.home-board-drag-preview').count()) await page.keyboard.press('Escape');
      await page.mouse.up();
    }
    rows[0].focus_tier = 'focus';
    await page.reload();
    await expect(board).toBeVisible();
  }
});
