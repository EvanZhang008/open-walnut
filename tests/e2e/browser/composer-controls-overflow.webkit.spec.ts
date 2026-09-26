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
  await expect(controlOf(panel, 'mode').locator('.mode-toggle-pill-shortcut')).toBeVisible();
  await expect(controlOf(panel, 'output').locator('.mode-toggle-pill-label')).toHaveText('Rich');
  await expectSingleRow(panel);
  await shootComposer(panel, 'wide');
});

test('a narrow column collapses to one row and the menu names the hidden controls', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  await expect(overflowBtn(panel)).toBeVisible();
  const state = await rowState(panel);
  expect(state.visible).toEqual(['mode', 'output']);
  expect(state.hidden).toEqual(['model', 'btw', 'note']);
  await expect(controlOf(panel, 'mode').locator('.mode-toggle-pill-shortcut')).toBeHidden();
  expect(await controlOf(panel, 'output').locator('button').evaluate((button) => getComputedStyle(button, '::after').content)).toBe('"R"');
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

test('the condensed reply-style control acts on the real session setting', async ({ page }) => {
  const writes: SettingsWrites = { body: [] };
  await mockControlsSession(page, CTRL_SESSION, writes);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true });
  const button = controlOf(panel, 'output').locator('button');
  await expect(button).toHaveAttribute('aria-label', 'Output mode: Rich');
  await button.click();
  await expect(button).toHaveAttribute('aria-label', 'Output mode: MD');
  expect(await button.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"M"');
  await expect.poll(() => writes.body.some((b) => b.output_mode === 'markdown')).toBe(true);
});
