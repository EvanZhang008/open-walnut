import fs from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { loadHome } from './draft-helpers';
import { isolateUiPrefs } from './todo-panel-helpers';
import { stubSttStatus } from './voice-selection-helpers';

// Linux WebKit has no MediaRecorder. This only checks painting/focus/popover
// placement with its capability visible; actual capture is accepted in Chromium.
// The constructor refuses any recording attempt, so this cannot pass as a media test.
test.use({ viewport: { width: 1280, height: 860 } });
test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page);
  await stubSttStatus(page);
  await page.addInitScript(() => {
    if (typeof MediaRecorder !== 'undefined') return;
    class LayoutOnlyRecorder {
      static isTypeSupported() { return true; }
      constructor() { throw new Error('Layout-only recorder: capture is not supported in this test'); }
    }
    Object.defineProperty(window, 'MediaRecorder', { value: LayoutOnlyRecorder, configurable: true });
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
    if (!navigator.mediaDevices.getUserMedia) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: () => Promise.reject(new Error('Layout test never captures audio')) });
  });
});

async function field(page: Page, input: Locator, name: string) {
  await expect(input).toBeVisible();
  const wrapper = input.locator('xpath=..');
  const mic = wrapper.locator('.mic-btn').first();
  await expect(mic).toBeVisible();
  const box = (await input.boundingBox())!;
  const button = (await mic.boundingBox())!;
  expect(button.x).toBeGreaterThanOrEqual(box.x);
  expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width + 1);
  expect(button.y).toBeGreaterThanOrEqual(box.y - 1);
  expect(button.y + button.height).toBeLessThanOrEqual(box.y + box.height + 1);
  expect(await mic.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === el || el.contains(hit);
  })).toBe(true);
  await input.fill('Editable words');
  await expect(input).toHaveValue('Editable words');
  await input.fill('');
  const dir = process.env.VOICE_LAYOUT_SHOTS ?? '/tmp/voice-field-layout';
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

test('Org search mic fits its field and manual typing still works', async ({ page }) => {
  await loadHome(page);
  await page.getByTestId('sidebar-org').click();
  await field(page, page.getByTestId('org-search'), 'org-search');
});

test('Settings filter and focus-tier name keep their mics inside their fields', async ({ page }) => {
  await loadHome(page);
  await page.locator('a[href^="/settings"]').first().click();
  await field(page, page.getByTestId('settings-filter'), 'settings-filter');
  await page.getByTestId('settings-nav-tasks').click();
  const input = page.locator('#focus-tiers-new');
  await input.scrollIntoViewIfNeeded();
  await field(page, input, 'focus-tier');
  await input.locator('xpath=..').locator('.mic-btn').click({ button: 'right' });
  const popup = page.locator('body > .mic-retry-dropdown.mic-popover');
  await expect(popup).toBeVisible();
  const r = (await popup.boundingBox())!;
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + r.width).toBeLessThanOrEqual(1280);
  expect(r.y + r.height).toBeLessThanOrEqual(860);
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await expect(input).toBeVisible();
});
