import { test, expect, type Locator } from '@playwright/test';
import {
  CTRL_SESSION, CTRL_FILLER, mockControlsSession, openControlsSession,
  overflowBtn, controlOf, rowState, expectSingleRow, shootComposer,
  type SettingsWrites,
} from './composer-controls-overflow-helpers';

const addButton = (panel: Locator) => panel.locator('.session-panel-input .chat-plus-btn');
const addMenu = (panel: Locator) => panel.locator('.session-panel-input .chat-plus-menu');
const addRow = (panel: Locator, id: string) => addMenu(panel).locator(`[data-add-control="${id}"]`);

test('wide composer keeps only full model and mode inline; add menu holds reply style, side thread and note', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await openControlsSession(page, { narrow: false });
  expect((await rowState(panel)).visible).toEqual(['mode', 'model']);
  await expect(overflowBtn(panel)).toHaveCount(0);
  await expect(controlOf(panel, 'mode').locator('.mode-toggle-pill-shortcut')).toBeVisible();
  await expect(controlOf(panel, 'model').locator('button')).toContainText('Fable');
  await expectSingleRow(panel);

  await addButton(panel).click();
  await expect(addRow(panel, 'output')).toContainText('Rich');
  await expect(addRow(panel, 'btw')).toBeVisible();
  await expect(addRow(panel, 'note')).toHaveText('Note');
  await expect(controlOf(panel, 'output').locator('button')).toBeHidden();
  await expect(controlOf(panel, 'btw').locator('button')).toBeHidden();
  await expect(controlOf(panel, 'note').locator('button')).toBeHidden();
  const box = await addMenu(panel).boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect.poll(() => addMenu(panel).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await shootComposer(panel, 'wide-add-menu', 420);
});

test('narrow composer shows Bypass without shortcut and model context percentage without an overflow button', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await expect(controlOf(panel, 'model').locator('.session-detail-context-pct')).toContainText('45%');
  await expect.poll(() => rowState(panel).then((state) => state.visible)).toEqual(['mode', 'model']);
  await expect(controlOf(panel, 'mode').locator('.mode-toggle-pill-label')).toHaveText('Bypass');
  await expect(controlOf(panel, 'mode').locator('.mode-toggle-pill-shortcut')).toBeHidden();
  const model = controlOf(panel, 'model').locator('button');
  expect(await model.evaluate((el) => getComputedStyle(el).fontSize)).toBe('0px');
  expect(await model.locator('.session-detail-context-pct').evaluate((el) => getComputedStyle(el).fontSize)).toBe('11px');
  await expect(model).toHaveAttribute('title', /fable-5-1/);
  await expect(overflowBtn(panel)).toHaveCount(0);
  await expectSingleRow(panel);
  await shootComposer(panel, 'narrow');
});

test('reply style in add menu updates the session twice and keeps the menu label in sync', async ({ page }) => {
  const writes: SettingsWrites = { body: [] };
  await mockControlsSession(page, CTRL_SESSION, writes);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  const text = panel.locator('.session-panel-input .chat-input-textarea');
  await text.fill('Do not send this draft');
  await addButton(panel).click();
  await expect(addRow(panel, 'output')).toContainText('Rich');
  await addRow(panel, 'output').click();
  await expect.poll(() => writes.body.some((body) => body.output_mode === 'markdown')).toBe(true);
  await expect(text).toHaveValue('Do not send this draft');
  await addButton(panel).click();
  await expect(addRow(panel, 'output')).toContainText('MD');
  await addRow(panel, 'output').click();
  await expect.poll(() => writes.body.some((body) => body.output_mode === 'rich')).toBe(true);
  await addButton(panel).click();
  await expect(addRow(panel, 'output')).toContainText('Rich');
  await shootComposer(panel, 'reply-style-restored', 420);
});

test('side thread and note open from the add menu and keep their content visible after the menu closes', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await addButton(panel).click();
  await addRow(panel, 'btw').click();
  await expect(addMenu(panel)).toHaveCount(0);
  await expect(panel.locator('.session-panel-input .side-question-popover--threads')).toBeVisible();
  await expect(panel.locator('.session-panel-input .side-question-composer textarea')).toBeVisible();
  await shootComposer(panel, 'side-thread', 420);
  await page.keyboard.press('Escape');
  await expect(panel.locator('.session-panel-input .side-question-popover--threads')).toHaveCount(0);

  await addButton(panel).click();
  await addRow(panel, 'note').click();
  await expect(panel.locator('.session-panel-input .session-notes-editor')).toBeVisible();
  await expect(addMenu(panel)).toHaveCount(0);
  await expect(controlOf(panel, 'note')).toHaveAttribute('data-hidden', 'true');
});

test('model picker stays anchored and repeated resize restores full model without moving add actions inline', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await controlOf(panel, 'model').locator('button').click();
  await expect(page.locator('.model-picker').first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 2200, height: 800 });
  await expect.poll(() => controlOf(panel, 'model').locator('button').innerText()).toContain('Fable');
  expect((await rowState(panel)).visible).toEqual(['mode', 'model']);
  await expect(overflowBtn(panel)).toHaveCount(0);
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(() => controlOf(panel, 'model').locator('button').evaluate((el) => getComputedStyle(el).fontSize)).toBe('0px');
  await expect(controlOf(panel, 'model').locator('.session-detail-context-pct')).toContainText('45%');
  expect((await rowState(panel)).visible).toEqual(['mode', 'model']);
  await expectSingleRow(panel);
  await addButton(panel).click();
  await expect(addRow(panel, 'btw')).toBeVisible();
});

test('unknown context percentage is never invented and model remains selectable', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION, undefined, 0);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await expect(controlOf(panel, 'model').locator('.session-detail-context-pct')).toHaveCount(0);
  const model = controlOf(panel, 'model').locator('button');
  await expect(model).toHaveAttribute('title', /fable-5-1/);
  await model.click();
  await expect(page.locator('.model-picker').first()).toBeVisible({ timeout: 10_000 });
  await expectSingleRow(panel);
});

test('failed reply-style update restores the previous value and stays usable', async ({ page }) => {
  const writes: SettingsWrites = { body: [] };
  await mockControlsSession(page, CTRL_SESSION, writes);
  const rejectUpdate = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    writes.body.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 503, json: { error: 'Temporary failure' } });
  };
  await page.route(`**/api/sessions/${CTRL_SESSION}`, rejectUpdate);
  const panel = await openControlsSession(page, { narrow: false });
  await addButton(panel).click();
  await addRow(panel, 'output').click();
  await expect.poll(() => writes.body.length).toBeGreaterThan(0);
  await addButton(panel).click();
  await expect(addRow(panel, 'output')).toContainText('Rich');
  await addButton(panel).click();
  await page.unroute(`**/api/sessions/${CTRL_SESSION}`, rejectUpdate);
  await addButton(panel).click();
  await addRow(panel, 'output').click();
  await expect.poll(() => writes.body.some((body) => body.output_mode === 'markdown')).toBe(true);
  await addButton(panel).click();
  await expect(addRow(panel, 'output')).toContainText('MD');
});

test('two rapid style changes send sequential writes and retain the last choice', async ({ page }) => {
  const writes: SettingsWrites = { body: [] };
  await mockControlsSession(page, CTRL_SESSION, writes);
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstArrivedSignal: (() => void) | undefined;
  const firstArrived = new Promise<void>((resolve) => { firstArrivedSignal = resolve; });
  await page.route(`**/api/sessions/${CTRL_SESSION}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    writes.body.push(route.request().postDataJSON() as Record<string, unknown>);
    if (writes.body.length === 1) { firstArrivedSignal?.(); await firstBlocked; }
    await route.fulfill({ json: { session: {
      claudeSessionId: CTRL_SESSION, mode: 'bypass', process_status: 'idle',
      output_mode: route.request().postDataJSON().output_mode,
    } } });
  });
  const panel = await openControlsSession(page, { narrow: false });
  const add = addButton(panel);
  await add.click();
  await addRow(panel, 'output').click();
  await firstArrived;
  try {
    await add.click();
    await expect(addRow(panel, 'output')).toContainText('MD');
    await addRow(panel, 'output').click();
    await expect(addRow(panel, 'output')).toHaveCount(0);
    expect(writes.body).toHaveLength(1);
  } finally {
    releaseFirst?.();
  }
  await expect.poll(() => writes.body.length).toBe(2);
  await expect.poll(() => writes.body.at(-1)?.output_mode).toBe('rich');
  await add.click();
  await expect(addRow(panel, 'output')).toContainText('Rich');
});

test('a later failed style change restores the last confirmed value', async ({ page }) => {
  const writes: SettingsWrites = { body: [] };
  await mockControlsSession(page, CTRL_SESSION, writes);
  let releaseFirst: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstArrivedSignal: (() => void) | undefined;
  const firstArrived = new Promise<void>((resolve) => { firstArrivedSignal = resolve; });
  await page.route(`**/api/sessions/${CTRL_SESSION}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    writes.body.push(route.request().postDataJSON() as Record<string, unknown>);
    if (writes.body.length === 1) {
      firstArrivedSignal?.();
      await held;
      await route.fulfill({ json: { session: {
        claudeSessionId: CTRL_SESSION, process_status: 'idle', mode: 'bypass', output_mode: 'markdown',
      } } });
      return;
    }
    await route.fulfill({ status: 503, json: { error: 'Temporary failure' } });
  });
  const panel = await openControlsSession(page, { narrow: false });
  await addButton(panel).click();
  await addRow(panel, 'output').click();
  await firstArrived;
  try {
    await addButton(panel).click();
    await addRow(panel, 'output').click();
    expect(writes.body).toHaveLength(1);
  } finally {
    releaseFirst?.();
  }
  await expect.poll(() => writes.body.length).toBe(2);
  await addButton(panel).click();
  await expect(addRow(panel, 'output')).toContainText('MD');
});

test('short viewport scrolls the add menu to every action without clipping', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await openControlsSession(page, { narrow: false });
  await page.setViewportSize({ width: 1200, height: 420 });
  await addButton(panel).click();
  const menu = addMenu(panel);
  const box = await menu.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(420);
  await addRow(panel, 'note').scrollIntoViewIfNeeded();
  await expect(addRow(panel, 'note')).toBeVisible();
  await addRow(panel, 'note').click();
  await expect(panel.locator('.session-panel-input .session-notes-editor')).toBeVisible();
});

test('menu Escape, outside click and reload leave add actions and draft usable', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await openControlsSession(page, { narrow: false });
  await addButton(panel).click();
  await page.keyboard.press('Escape');
  await expect(addMenu(panel)).toHaveCount(0);
  await addButton(panel).click();
  await panel.locator('.session-history').click({ position: { x: 5, y: 5 } });
  await expect(addMenu(panel)).toHaveCount(0);
  const textarea = panel.locator('.session-panel-input .chat-input-textarea');
  await textarea.fill('A pending draft survives reload');
  await expect.poll(() => page.evaluate(() => Object.values(localStorage).includes('A pending draft survives reload'))).toBe(true);
  await page.reload();
  const reloaded = page.locator(`.main-page-session-column .session-panel[data-session-id="${CTRL_SESSION}"]`);
  await expect(reloaded.locator('.session-panel-input .chat-input-textarea')).toHaveValue('A pending draft survives reload');
  await addButton(reloaded).click();
  await expect(addRow(reloaded, 'output')).toContainText('Rich');
});
