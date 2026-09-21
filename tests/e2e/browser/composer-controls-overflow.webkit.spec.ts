/**
 * The composer controls row's overflow menu in WEBKIT — the engine the report
 * came from (the Mac app is a WKWebView). A subset of the Chromium matrix:
 * the two widths, the menu's labels, and one click through a proxy row.
 * Helpers: composer-controls-overflow-helpers.ts.
 */
import { test, expect } from '@playwright/test';
import {
  CTRL_SESSION, CTRL_FILLER, mockControlsSession, openControlsSession,
  overflowBtn, controlOf, rowState, expectSingleRow, shootComposer,
  expectMenuNamesHidden, CTRL_NAMES, type SettingsWrites,
} from './composer-controls-overflow-helpers';

test.use({ browserName: 'webkit' });

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

test('a wide column keeps every control on one row, with no overflow button', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await openControlsSession(page, { narrow: false });
  expect((await rowState(panel)).visible).toEqual(['mode', 'model', 'output', 'btw', 'note']);
  await expect(overflowBtn(panel)).toHaveCount(0);
  await expectSingleRow(panel);
  await shootComposer(panel, 'wide');
});

test('a narrow column collapses to one row and the menu names the hidden controls', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await expect(overflowBtn(panel)).toBeVisible();
  const state = await rowState(panel);
  expect(state.visible).toContain('mode');
  expect(state.hidden.length).toBeGreaterThan(0);
  expect(state.height).toBeLessThanOrEqual(26);
  await expectSingleRow(panel);
  await shootComposer(panel, 'narrow');

  await overflowBtn(panel).click();
  const menu = page.getByTestId('composer-overflow-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.composer-overflow-item')).toHaveCount(state.hidden.length);
  await expectMenuNamesHidden(panel, state.hidden, CTRL_NAMES);
  const box = await menu.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
  await shootComposer(panel, 'narrow-menu-open', 260);
});

test('a proxy row acts on the real control', async ({ page }) => {
  const writes: SettingsWrites = { body: [] };
  await mockControlsSession(page, CTRL_SESSION, writes);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await overflowBtn(panel).click();
  await page.getByTestId('composer-overflow-item-output').click();
  await expect.poll(() => controlOf(panel, 'output').evaluate((el) => (el.textContent ?? '').trim())).toBe('MD');
  await expect.poll(() => writes.body.some((b) => b.output_mode === 'markdown')).toBe(true);
});
