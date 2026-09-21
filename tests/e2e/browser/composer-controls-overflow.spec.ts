/**
 * The composer controls row's overflow menu, in Chromium. WebKit twin:
 * composer-controls-overflow.webkit.spec.ts. Matrix and helpers:
 * composer-controls-overflow-helpers.ts.
 */
import { test, expect } from '@playwright/test';
import {
  CTRL_SESSION, CTRL_FILLER, mockControlsSession, openControlsSession,
  overflowBtn, controlOf, rowState, expectSingleRow, shootComposer,
  expectMenuNamesHidden, CTRL_NAMES, forceAllVisibleGeometry, type SettingsWrites,
} from './composer-controls-overflow-helpers';

test('1. a wide column keeps every control on one row, with no overflow button', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await openControlsSession(page, { narrow: false });
  const state = await rowState(panel);
  expect(state.visible).toEqual(['mode', 'model', 'output', 'btw', 'note']);
  expect(state.hidden).toEqual([]);
  await expect(overflowBtn(panel)).toHaveCount(0);
  await expectSingleRow(panel);
  await shootComposer(panel, 'wide');
});

test('2. a narrow column collapses to one row: the mode pill plus the button', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await expect(overflowBtn(panel)).toBeVisible();
  const state = await rowState(panel);
  expect(state.visible).toContain('mode');
  expect(state.hidden.length, 'nothing moved into the menu').toBeGreaterThan(0);
  await expectSingleRow(panel);
  // One pill tall: the reported bug was a row four pills high.
  expect(state.height).toBeLessThanOrEqual(26);
  await shootComposer(panel, 'narrow');
});

test('3. the menu names each hidden control, carries its live state, and fits the viewport', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  const hidden = (await rowState(panel)).hidden;
  await overflowBtn(panel).click();
  const menu = page.getByTestId('composer-overflow-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.composer-overflow-item')).toHaveCount(hidden.length);
  await expectMenuNamesHidden(panel, hidden, CTRL_NAMES);
  const box = await menu.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
  await shootComposer(panel, 'narrow-menu-open', 260);
});

test('4. a plain row acts on the REAL control: the reply-style pill flips', async ({ page }) => {
  const writes: SettingsWrites = { body: [] };
  await mockControlsSession(page, CTRL_SESSION, writes);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  const before = await controlOf(panel, 'output').evaluate((el) => (el.textContent ?? '').trim());
  expect(before).toBe('Rich');
  await overflowBtn(panel).click();
  await page.getByTestId('composer-overflow-item-output').click();
  // The hidden pill itself changed, and the row's label followed it.
  await expect.poll(() => controlOf(panel, 'output').evaluate((el) => (el.textContent ?? '').trim())).toBe('MD');
  await expect(page.getByTestId('composer-overflow-item-output').locator('.composer-overflow-item-value')).toHaveText('MD');
  await expect.poll(() => writes.body.some((b) => b.output_mode === 'markdown')).toBe(true);
});

test('5. an anchored row pins its pill onto the row and opens its picker there', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  expect((await rowState(panel)).hidden).toContain('model');
  await overflowBtn(panel).click();
  await page.getByTestId('composer-overflow-item-model').click();
  // The menu closed, the model pill is now ON the row, and its picker opened.
  await expect(page.getByTestId('composer-overflow-menu')).toHaveCount(0);
  await expect.poll(() => rowState(panel).then((s) => s.visible)).toContain('model');
  await expect(page.locator('.model-picker').first()).toBeVisible({ timeout: 10_000 });
  await expectSingleRow(panel);
  await shootComposer(panel, 'narrow-model-pinned');
});

test('6. Escape and an outside click close the menu', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await overflowBtn(panel).click();
  await expect(page.getByTestId('composer-overflow-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('composer-overflow-menu')).toHaveCount(0);
  await overflowBtn(panel).click();
  await expect(page.getByTestId('composer-overflow-menu')).toBeVisible();
  await panel.locator('.session-history').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('composer-overflow-menu')).toHaveCount(0);
});

test('7. the row follows the column: widening restores every pill, narrowing collapses again', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await expect(overflowBtn(panel)).toBeVisible();

  await page.setViewportSize({ width: 2200, height: 800 });
  await expect(overflowBtn(panel)).toHaveCount(0, { timeout: 5_000 });
  expect((await rowState(panel)).visible).toEqual(['mode', 'model', 'output', 'btw', 'note']);
  await expectSingleRow(panel);

  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(overflowBtn(panel)).toBeVisible({ timeout: 5_000 });
  await expectSingleRow(panel);

  // Settled, not oscillating: the same width must keep producing the same row.
  const first = await rowState(panel);
  await page.waitForTimeout(600);
  expect((await rowState(panel)).visible).toEqual(first.visible);
});

test('8. a pill whose picker is open is not hidden by a resize', async ({ page }) => {
  // The model picker is portalled to <body> and anchored to its pill: hiding the
  // pill out from under it would leave it pointing at a zero rect.
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: false });
  await controlOf(panel, 'model').locator('button').first().click();
  await expect(page.locator('.model-picker').first()).toBeVisible({ timeout: 10_000 });
  // Shrink until the row has to collapse; the touched pill keeps its place.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(overflowBtn(panel)).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => rowState(panel).then((s) => s.visible)).toContain('model');
  const box = await controlOf(panel, 'model').boundingBox();
  expect(box!.width, 'the pinned pill still has a real box for the picker to anchor to').toBeGreaterThan(0);
  await expectSingleRow(panel);
});

test('9. with the fit function bypassed the row stacks instead of spilling over the send cluster', async ({ page }) => {
  // The pre-measurement frame shows every control, so the CSS underneath has to
  // contain that row. Wrapping is kept for exactly this: squeezed narrower than
  // its pills, a non-wrapping row paints them on top of the mic/send buttons and
  // past the panel's right edge.
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await expect(overflowBtn(panel)).toBeVisible();
  const forced = await forceAllVisibleGeometry(panel);
  expect(forced.lines, 'five pills in a narrow column have to stack somewhere').toBeGreaterThan(1);
  expect(forced.overhang, 'the row ran under the mic/send cluster').toBeLessThanOrEqual(1);
  // The forced attributes outlive the next measure pass, and that is correct:
  // React owns `data-hidden`, and a pass that reaches the same answer as the
  // current state renders nothing. A real width change hands the row back.
  await page.setViewportSize({ width: 2200, height: 800 });
  await expect.poll(() => rowState(panel).then((s) => s.lines)).toBe(1);
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(overflowBtn(panel)).toBeVisible({ timeout: 5_000 });
  await expectSingleRow(panel);
});
