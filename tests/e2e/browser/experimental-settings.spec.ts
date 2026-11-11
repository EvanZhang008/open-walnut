import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1200, height: 820 }, deviceScaleFactor: 1 });
test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);
const SHOTS = process.env.WALNUT_TASK_DIR ? `${process.env.WALNUT_TASK_DIR}/evidence` : '/tmp/experimental-settings';
const switchId = '#experimental-leader_status_follows_workers';
const patch = (enabled: boolean) => ({ experimental: { leader_status_follows_workers: enabled } });

test('an explicit experimental choice survives navigation and reload, then turns off again', async ({ page, request }) => {
  await request.put('/api/config', { data: patch(false) });
  try {
    await page.goto('/settings');
    await page.getByTestId('settings-nav-experimental').click();
    const toggle = page.locator(switchId);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await (await request.get('/api/config')).json()).config.experimental.leader_status_follows_workers).toBe(true);
    await page.waitForTimeout(250);
    await page.screenshot({ scale: 'css', path: `${SHOTS}/experimental-on.png` });
    await page.getByTestId('settings-nav-general').click();
    await page.getByTestId('settings-nav-experimental').click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await (await request.get('/api/config')).json()).config.experimental.leader_status_follows_workers).toBe(false);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(toggle).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ scale: 'css', path: `${SHOTS}/experimental-phone.png` });
  } finally { await request.put('/api/config', { data: patch(false) }); }
});

test('a failed save restores the switch and a real retry succeeds', async ({ page, request }) => {
  await request.put('/api/config', { data: patch(false) });
  let reject = true;
  await page.route('**/api/config', async (route) => {
    if (reject && route.request().method() === 'PUT') return route.fulfill({ status: 500, json: { error: 'Could not save the configuration' } });
    return route.continue();
  });
  try {
    await page.goto('/settings');
    await page.getByTestId('settings-nav-experimental').click();
    const toggle = page.locator(switchId);
    await toggle.click();
    await expect(page.locator('#experimental')).toContainText("Couldn't save");
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    reject = false;
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await (await request.get('/api/config')).json()).config.experimental.leader_status_follows_workers).toBe(true);
  } finally { await page.unroute('**/api/config'); await request.put('/api/config', { data: patch(false) }); }
});
