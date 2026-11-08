import { expect, test, type Page } from '@playwright/test';
import { isolateUiPrefs } from './todo-panel-helpers';
import { answerTaskList } from './task-list-stub';

async function openHome(page: Page) {
  const started = Date.now();
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.setContent(`<a href="http://localhost:${process.env.PW_TEST_PORT ?? 3457}/">Open Walnut</a>`);
    await page.getByRole('link', { name: 'Open Walnut', exact: true }).click();
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 });
  } finally {
    page.off('pageerror', onError);
    await test.info().attach('home-load', { contentType: 'application/json', body: JSON.stringify({ durationMs: Date.now() - started, errors, url: page.url() }) });
  }
  expect(errors).toEqual([]);
}

test('board header controls stay reachable in narrow windows', async ({ page }) => {
  test.setTimeout(120_000);
  await isolateUiPrefs(page);
  await openHome(page);
  await page.getByRole('button', { name: 'Open task board', exact: true }).click();
  const board = page.getByTestId('home-board');
  for (const width of [250, 320, 390, 700, 1193]) {
    await page.setViewportSize({ width, height: 650 });
    await expect.poll(() => board.evaluate(el => {
      const sheet = el.getBoundingClientRect();
      return [...el.querySelectorAll('.home-board-controls button, .home-board-controls input')].every(node => {
        const box = node.getBoundingClientRect();
        return box.left >= sheet.left && box.right <= sheet.right && box.top >= sheet.top && box.bottom <= sheet.bottom;
      });
    })).toBe(true);
    await board.getByRole('button', { name: 'By status', exact: true }).click();
    await expect(board).toHaveAttribute('data-mode', 'status');
    await board.getByRole('button', { name: 'By pin', exact: true }).click();
  }
  await board.getByRole('button', { name: 'Close board', exact: true }).click();
  await expect(board).toHaveCount(0);
});

test('every nested card body activates only its own drag and leaves controls clickable', async ({ page }) => {
  test.setTimeout(120_000);
  const now = new Date().toISOString();
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `board-body-${i}`, title: `Board body task ${i}`, project: 'Board body project',
    source: 'local', category: '', status: 'todo', phase: 'TODO', priority: 'none', created_at: now, updated_at: now,
    pinned: true, focus_tier: 'focus', ...(i ? { parent_task_id: `board-body-${i - 1}` } : {}),
  }));
  await answerTaskList(page, () => rows);
  await isolateUiPrefs(page);
  await page.setViewportSize({ width: 1280, height: 1200 });
  await openHome(page);
  await page.getByRole('button', { name: 'Open task board', exact: true }).click();
  const board = page.getByTestId('home-board');
  await board.getByRole('button', { name: 'By pin', exact: true }).click();
  const cards = board.locator('[data-board-task]');
  await expect(cards).toHaveCount(rows.length);
  for (const node of await cards.all()) {
    const title = await node.locator(':scope > .home-board-card-top > .home-board-title').innerText();
    const body = node.locator(':scope > .home-board-meta > .home-board-state');
    const box = (await body.boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + box.height / 2);
    expect(await body.evaluate(el => { const css = getComputedStyle(el); return css.getPropertyValue('user-select') || css.getPropertyValue('-webkit-user-select'); })).toBe('none');
    await page.mouse.down();
    await page.mouse.move(box.x + 7, box.y + box.height / 2);
    await expect(board.locator('.home-board-drag-preview')).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(board).toBeVisible();
    await page.mouse.move(box.x + 5, box.y + box.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(box.x + 25, box.y + box.height / 2, { steps: 4 });
      await expect(board.locator('.home-board-drag-preview')).toHaveText(title);
      const previewBounds = await board.locator('.home-board-drag-preview').boundingBox();
      await test.info().attach(`body-grab-${title}`, { contentType: 'application/json', body: JSON.stringify({ body: box, pointer: { x: box.x + 25, y: box.y + box.height / 2 }, preview: previewBounds }) });
      await expect.poll(async () => {
        const preview = (await board.locator('.home-board-drag-preview').boundingBox())!;
        return box.x + 25 >= preview.x && box.x + 25 <= preview.x + preview.width && box.y + box.height / 2 >= preview.y && box.y + box.height / 2 <= preview.y + preview.height;
      }, { timeout: 5000, message: `The body grab must stay inside the preview for ${title}` }).toBe(true);
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
      await page.keyboard.press('Escape');
      await expect(board.locator('.home-board-drag-preview')).toHaveCount(0);
    } finally { await page.mouse.up(); }
    await expect(board).toBeVisible();
  }
  const rootCard = board.locator('[data-board-task="board-body-0"]');
  const rootBox = (await rootCard.boundingBox())!;
  const from = { x: rootBox.x + 5, y: rootBox.y + rootBox.height - 5 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    await page.mouse.move(from.x + 20, from.y, { steps: 4 });
    await expect(board.locator('.home-board-drag-preview')).toHaveText('Board body task 0');
    await expect.poll(async () => {
      const box = (await board.locator('.home-board-drag-preview').boundingBox())!;
      return from.y >= box.y && from.y <= box.y + box.height;
    }).toBe(true);
    await page.keyboard.press('Escape');
  } finally { await page.mouse.up(); }
  const child = board.locator('[data-board-task="board-body-1"]');
  await child.locator(':scope > .home-board-meta [data-board-move]').click();
  await expect(page.getByRole('listbox', { name: 'Move to pin tier' })).toBeVisible();
  await expect(board.locator('.home-board-drag-preview')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await child.locator(':scope > .home-board-family > button').click();
  await expect(board.locator('[data-board-task="board-body-2"]')).toHaveCount(0);
  await expect(board.locator('.home-board-drag-preview')).toHaveCount(0);
  await child.locator(':scope > .home-board-card-top > .home-board-title').click();
  await expect(board).toHaveCount(0);
  await expect(page.locator('.todo-detail-pane[data-task-id="board-body-1"]')).toBeVisible();
});

test('dense board scrolls horizontally from cards and keeps one clipping boundary per scroll area', async ({ page }) => {
  test.setTimeout(120_000);
  const now = new Date().toISOString();
  const rows = Array.from({ length: 152 }, (_, i) => ({
    id: `board-scroll-${i}`, title: `Board scroll task ${i} ${'x'.repeat(80)}`, project: `Board scroll project ${i % 9}`,
    source: 'local', category: '', status: 'todo', phase: 'TODO', priority: 'none', created_at: now, updated_at: now,
    pinned: i % 5 !== 4, focus_tier: ['focus', 'satellite', 'wait', 'ct_scroll', null][i % 5],
    user_status: { state: ['needs', 'working', 'waiting'][i % 3], at: now },
  }));
  await answerTaskList(page, () => rows);
  await page.route('**/api/focus/tiers', route => route.fulfill({ json: { tiers: [{ id: 'ct_scroll', label: 'Release' }] } }));
  await page.route('**/api/focus/tasks', route => route.fulfill({ json: {
    pinned_tasks: rows.filter(t => t.pinned).map(t => t.id),
    focus_tasks: rows.filter(t => t.focus_tier === 'focus').map(t => t.id),
    satellite_tasks: rows.filter(t => t.focus_tier === 'satellite').map(t => t.id),
    wait_tasks: rows.filter(t => t.focus_tier === 'wait').map(t => t.id),
    custom_tier_tasks: { ct_scroll: rows.filter(t => t.focus_tier === 'ct_scroll').map(t => t.id) },
  } }));
  await isolateUiPrefs(page);
  await page.setViewportSize({ width: 1000, height: 718 });
  await openHome(page);
  await page.getByRole('button', { name: 'Open task board', exact: true }).click();
  const board = page.getByTestId('home-board');
  const strip = board.locator('.home-board-columns');
  for (let round = 0; round < 3; round++) {
    const card = board.locator('[data-board-column="focus"] .home-board-card').first();
    const box = (await card.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 15);
    await page.mouse.wheel(600, 0);
    await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
    await page.setViewportSize({ width: 2327, height: 1252 });
    await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBe(0);
    await page.setViewportSize({ width: 1000, height: 718 });
    await expect.poll(() => board.evaluate(el => {
      const sheet = getComputedStyle(el);
      const faults: string[] = [];
      if (sheet.overflowX !== 'visible' || sheet.overflowY !== 'visible') faults.push('duplicate sheet clipping');
      for (const col of el.querySelectorAll('[data-board-column]')) {
        const head = col.querySelector('header')!.getBoundingClientRect();
        const body = col.querySelector('.home-board-column-body')!;
        const css = getComputedStyle(body);
        if (css.overscrollBehaviorX !== 'auto' || css.overscrollBehaviorY !== 'contain') faults.push('horizontal chain blocked');
        if (body.scrollWidth > body.clientWidth + 1) faults.push('inner horizontal overflow');
        for (const task of col.querySelectorAll('.home-board-card')) {
          const rect = task.getBoundingClientRect();
          if (rect.left < head.left - 1 || rect.right > head.right + 1) faults.push('card outside column');
        }
      }
      return faults;
    })).toEqual([]);
    const body = board.locator('[data-board-column="focus"] .home-board-column-body');
    const area = (await body.boundingBox())!;
    const headerTop = await board.locator('[data-board-column="focus"] header').evaluate(el => el.getBoundingClientRect().top);
    await page.mouse.move(area.x + area.width / 2, area.y + 80);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
    expect(await board.locator('[data-board-column="satellite"] .home-board-column-body').evaluate(el => el.scrollTop)).toBe(0);
    expect(await board.locator('[data-board-column="focus"] header').evaluate(el => el.getBoundingClientRect().top)).toBe(headerTop);
    await page.mouse.wheel(0, -1000);
    await expect.poll(() => body.evaluate(el => el.scrollTop)).toBe(0);
  }
});
