// Opening a voice conversation in a session's composer, at every column width.
//
// 2026-11-23: on the Org page, Talk in the lead's chat turned the send slot into the
// wider voice keys; the controls row beside them lost room, landed where it flipped
// between two shapes on every measure, and React stopped it ("Maximum update depth
// exceeded"). The composer's boundary took the voice keys down with it, so "Back to
// the keyboard" was gone and Retry mounted the same open voice again: no way back.
// Under about 320 px the voice keys also spilled out of their box and the send key covered
// "Back to the keyboard". This walks the widths with voice opening and closing, and checks
// the row holds and the way back can be pressed.
// Chromium only: Playwright's Linux WebKit has no MediaRecorder.
import { test, expect, type Page } from '@playwright/test';
import {
  CTRL_SESSION, CTRL_FILLER, mockControlsSession, openControlsSession, clampColumn,
} from './composer-controls-overflow-helpers';
import { useSyntheticMic } from './fake-mic';

async function enableVoice(page: Page): Promise<void> {
  await useSyntheticMic(page, { gain: 0.0005 });
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const json = await res.json();
    json.config.experimental = { ...(json.config.experimental ?? {}), voice_conversation: true };
    await route.fulfill({ response: res, json });
  });
  await page.route((url) => url.pathname === '/api/v1/voice/status' || url.pathname === '/api/v1/voice/warmup',
    (route) => route.fulfill({ json: { engine: 'elevenlabs', engines: [] } }));
}

test('voice opens and closes at every column width, and the controls row and composer stay', async ({ page }) => {
  test.setTimeout(300_000);
  const loops: string[] = [];
  page.on('console', (m) => { if (/Maximum update depth|render error caught by boundary|kept changing its shape/.test(m.text())) loops.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => loops.push(e.message));
  await enableVoice(page);
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true, width: 1280 });
  const talk = panel.getByTestId('voice-talk-entry');
  const bar = panel.getByTestId('voice-bar');
  await expect(talk).toBeVisible();
  const failedAt: string[] = [];
  for (let width = 240; width <= 640; width += 4) {
    await clampColumn(page, width, { exact: true });
    await page.waitForTimeout(120);
    await talk.click({ timeout: 10_000 });
    // The voice keys take the send slot while the row is still taking its shape.
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(350);
    if (await page.locator('[data-error-region]').count() || loops.length) { failedAt.push(`${width}px`); break; }
    // The way back is on top where it is drawn: nothing (the send key) covers it.
    const onTop = await panel.getByTestId('voice-close').evaluate((el) => {
      const b = el.getBoundingClientRect();
      const row = el.closest('.chat-input-controls')?.getBoundingClientRect();
      // Inside its row (not spilled past the send key or the box's edge) and on top there.
      const inRow = !!row && b.left >= row.left - 0.5 && b.right <= row.right + 0.5;
      return inRow && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('[data-testid="voice-close"]') === el;
    });
    if (!onTop) { failedAt.push(`${width}px: Back to the keyboard is covered`); break; }
    await panel.getByTestId('voice-close').click({ timeout: 10_000 });
    await expect(talk).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(120);
    if (await page.locator('[data-error-region]').count() || loops.length) { failedAt.push(`${width}px (closing)`); break; }
  }
  expect(failedAt, `the composer row looped or a part crashed: ${loops.join(' | ')}`).toEqual([]);
  await clampColumn(page, null);
  const box = panel.locator('.session-panel-input textarea').first();
  await box.fill('the composer still types after voice');
  await expect(box).toHaveValue('the composer still types after voice');
});

test('the controls row crashing while voice is open leaves Back to the keyboard and the box working', async ({ page }) => {
  // The crash hook listens only on a page that turned it on before it loaded.
  await page.addInitScript(() => { (window as { __walnutTestCrashHooks?: boolean }).__walnutTestCrashHooks = true; });
  await enableVoice(page);
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  const panel = await openControlsSession(page, { narrow: true, width: 1280 });
  await panel.getByTestId('voice-talk-entry').click();
  await expect(panel.getByTestId('voice-bar')).toBeVisible();
  await page.evaluate((key) => window.dispatchEvent(new CustomEvent('walnut:test-crash', { detail: { region: 'composer-controls', key } })), CTRL_SESSION);
  await expect(panel.locator('.session-panel-input [data-error-region="composer-controls"]')).toBeVisible();
  // Only the row went: the box and the voice keys are still there, and the way back works.
  await expect(panel.locator('[data-error-region="composer"]')).toHaveCount(0);
  await panel.getByTestId('voice-close').click();
  await expect(panel.getByTestId('voice-talk-entry')).toBeVisible();
  const box = panel.locator('.session-panel-input textarea').first();
  await box.fill('back on the keyboard');
  await expect(box).toHaveValue('back on the keyboard');
  // The "+" menu holds no blank rows for the controls that are gone.
  await panel.locator('.session-panel-input .chat-plus-btn').click();
  const menu = panel.locator('.session-panel-input .chat-plus-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-add-control]')).toHaveCount(0);
});
