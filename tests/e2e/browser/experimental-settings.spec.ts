import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1200, height: 820 }, deviceScaleFactor: 1 });
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);
const SHOTS = process.env.WALNUT_TASK_DIR ? `${process.env.WALNUT_TASK_DIR}/evidence` : '/tmp/experimental-settings';
const switchId = '#experimental-leader_status_follows_workers';
/** After a reload the fixture's dev server serves every module again: on a busy host that took over 15 s (2026-11-22). */
const AFTER_RELOAD = { timeout: 45_000 };
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
    await expect(toggle).toHaveAttribute('aria-checked', 'true', AFTER_RELOAD);
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

test('"Every experiment on" turns on every switch never set alone, keeps one turned off, and turns back off', async ({ page, request }) => {
  const everyId = '#experimental-every_experiment';
  const voiceId = '#experimental-voice_conversation';
  const flags = async () => (await (await request.get('/api/config')).json()).config.experimental ?? {};
  const reset = { experimental: { every_experiment: false, voice_conversation: null, leader_status_follows_workers: false, restore_drill: null, switchable_leader: null } };
  await request.put('/api/config', { data: reset });
  try {
    await page.goto('/settings');
    await page.getByTestId('settings-nav-experimental').click();
    const every = page.locator(everyId);
    const voice = page.locator(voiceId);
    const leader = page.locator(switchId);
    await expect(every).toHaveAttribute('aria-checked', 'false', AFTER_RELOAD);
    await expect(voice).toHaveAttribute('aria-checked', 'false');
    await every.click();
    await expect(every).toHaveAttribute('aria-checked', 'true');
    await expect(voice).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await flags()).every_experiment).toBe(true);
    // The experiment the user turned off stays off; the rest follow.
    await expect(leader).toHaveAttribute('aria-checked', 'false');
    // The two that copy or download all of the data keep their own switch, and say so.
    for (const id of ['restore_drill', 'switchable_leader']) {
      await expect(page.locator(`#experimental-${id}`)).toHaveAttribute('aria-checked', 'false');
      expect((await flags())[id]).toBeUndefined();
    }
    // The help names what it leaves out since 8da4150cbe ("ones that copy your data or move sessions").
    await expect(page.getByText('ones that copy your data or move sessions')).toBeVisible();
    await page.reload();
    await expect(every).toHaveAttribute('aria-checked', 'true', AFTER_RELOAD);
    await expect(voice).toHaveAttribute('aria-checked', 'true');
    // Voice was only implied: it is not frozen on disk.
    expect((await flags()).voice_conversation).toBeUndefined();
    await page.waitForTimeout(250);
    await page.screenshot({ scale: 'css', path: `${SHOTS}/experimental-every-on.png` });
    await every.click();
    await expect(every).toHaveAttribute('aria-checked', 'false');
    await expect(voice).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await flags()).every_experiment).toBe(false);
  } finally { await request.put('/api/config', { data: reset }); }
});
