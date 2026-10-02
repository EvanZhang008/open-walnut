import { test, expect } from '@playwright/test';
import {
  CTRL_SESSION, CTRL_FILLER, COLUMN_NAME_ONLY, mockControlsSession, openControlsSession, clampColumn,
  overflowBtn, controlOf, rowState, expectSingleRow, shootComposer,
  type SettingsWrites,
} from './composer-controls-overflow-helpers';
import { openDraft } from './draft-helpers';

test.use({ browserName: 'webkit' });

test('WebKit wide composer leaves full model and Bypass inline while the add menu lists other controls', async ({ page, browserName }) => {
  expect(browserName).toBe('webkit');
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await openControlsSession(page, { narrow: false });
  expect((await rowState(panel)).visible).toEqual(['mode', 'model']);
  await expect(controlOf(panel, 'mode').locator('.mode-toggle-pill-shortcut')).toBeVisible();
  await expect(controlOf(panel, 'model').locator('button')).toContainText('Fable');
  await expect(overflowBtn(panel)).toHaveCount(0);
  await expectSingleRow(panel);
  await panel.locator('.session-panel-input .chat-plus-btn').click();
  const menu = panel.locator('.session-panel-input .chat-plus-menu');
  for (const id of ['output', 'btw', 'note']) await expect(menu.locator(`[data-add-control="${id}"]`)).toBeVisible();
  await expect(menu.locator('[data-add-control="note"]')).toHaveText('Note');
  expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
  await expect.poll(() => menu.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await shootComposer(panel, 'wide-add-menu', 420);
});

test('WebKit narrow composer shows Bypass and the short model name with the real percentage, then switches Rich to MD in the add menu', async ({ page }) => {
  const writes: SettingsWrites = { body: [] };
  await mockControlsSession(page, CTRL_SESSION, writes);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  expect((await rowState(panel)).visible).toEqual(['mode', 'model']);
  await expect(controlOf(panel, 'mode').locator('.mode-toggle-pill-shortcut')).toBeHidden();
  const model = controlOf(panel, 'model').locator('button');
  await expect(model.locator('.composer-model-pill-short')).toHaveText('Fable');
  await expect(model.locator('.session-detail-context-pct')).toContainText('45%');
  await expect(model).toHaveText(/^Fable\s*45%$/);
  expect(await model.evaluate((el) => getComputedStyle(el).fontSize)).toBe('11px');
  await expect(overflowBtn(panel)).toHaveCount(0);
  await expectSingleRow(panel);
  await shootComposer(panel, 'narrow');
  // Tighter still: the name stays, the percentage goes, and the row is still one line.
  await clampColumn(page, COLUMN_NAME_ONLY);
  await expect(model.locator('.session-detail-context-pct')).toHaveCount(0);
  await expect(model).toHaveText(/^Fable$/);
  expect((await rowState(panel)).visible).toEqual(['mode', 'model']);
  await expectSingleRow(panel);
  await shootComposer(panel, 'tight');
  await clampColumn(page, null);
  await expect(model.locator('.session-detail-context-pct')).toContainText('45%');
  await panel.locator('.session-panel-input .chat-plus-btn').click();
  const output = panel.locator('.session-panel-input [data-add-control="output"]');
  await expect(output).toContainText('Rich');
  const menu = panel.locator('.session-panel-input .chat-plus-menu');
  await expect.poll(() => menu.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  const menuBox = await menu.boundingBox();
  const vp = page.viewportSize()!;
  expect(menuBox).toBeTruthy();
  expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  expect(menuBox!.y).toBeGreaterThanOrEqual(0);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(vp.width);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(vp.height);
  const addBox = await panel.locator('.session-panel-input .chat-plus-btn').boundingBox();
  expect(Math.abs(menuBox!.x - addBox!.x), JSON.stringify({ menuBox, addBox })).toBeLessThanOrEqual(12);
  expect(menuBox!.width).toBeLessThan(300);
  const menuHit = await menu.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return document.elementFromPoint(rect.left + 80, rect.top + 20)?.closest('.chat-plus-menu') === el;
  });
  expect(menuHit, 'another element covers the open add menu').toBe(true);
  await shootComposer(panel, 'narrow-add-menu', 420);
  await output.click();
  await expect.poll(() => writes.body.some((body) => body.output_mode === 'markdown')).toBe(true);
  await panel.locator('.session-panel-input .chat-plus-btn').click();
  await expect(output).toContainText('MD');
});

test('WebKit short viewport keeps the note row reachable in the add menu', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await openControlsSession(page, { narrow: false });
  await page.setViewportSize({ width: 1200, height: 420 });
  await panel.locator('.session-panel-input .chat-plus-btn').click();
  const menu = panel.locator('.session-panel-input .chat-plus-menu');
  const box = await menu.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(420);
  const note = menu.locator('[data-add-control="note"]');
  await note.scrollIntoViewIfNeeded();
  await note.click();
  await expect(panel.locator('.session-panel-input .session-notes-editor')).toBeVisible();
});

test('WebKit draft add menu remains aligned, scrollable and dismissible', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await page.goto('/');
  const draft = await openDraft(page);
  const add = draft.locator('.chat-plus-btn');
  await add.click();
  const menu = draft.locator('.chat-plus-menu');
  await expect(menu.getByRole('menuitem', { name: 'Attach image' })).toBeVisible();
  const box = await menu.boundingBox();
  const addBox = await add.boundingBox();
  expect(box).toBeTruthy();
  expect(Math.abs(box!.x - addBox!.x)).toBeLessThanOrEqual(12);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(500);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('WebKit side thread and note open from add menu and stay usable', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  const add = panel.locator('.session-panel-input .chat-plus-btn');
  await add.click();
  await panel.locator('.session-panel-input [data-add-control="btw"]').click();
  await expect(panel.locator('.session-panel-input .side-question-popover--threads')).toBeVisible();
  await expect(panel.locator('.session-panel-input .side-question-composer textarea')).toBeVisible();
  await page.keyboard.press('Escape');
  await add.click();
  await panel.locator('.session-panel-input [data-add-control="note"]').click();
  await expect(panel.locator('.session-panel-input .session-notes-editor')).toBeVisible();
});
