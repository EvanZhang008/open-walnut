/**
 * The composer's permission-mode pill is a menu (2026-11-12, the user: "remove the tab thing
 * not needed ... make it drop down menu can select"): no shortcut hint on the pill, a click
 * lists every mode with the current one checked, a pick switches to it. Walked on the three
 * composers that draw it: a running session, the side-thread drawer and the new-task draft.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { mockControlsSession, CTRL_SESSION, directControl, type SettingsWrites } from './composer-controls-overflow-helpers';
import { openDraft } from './draft-helpers';
import { modeMenu, pickMode } from './permission-mode-helpers';

test.use({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 });

const SHOTS = process.env.MODE_MENU_SHOTS ?? '/tmp/permission-mode-menu';
const LABELS = ['Plan', 'Default', "Don't Ask", 'Accept', 'Auto', 'Bypass'];

async function enterHome(page: Page): Promise<Locator> {
  await page.addInitScript((id) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]));
  }, CTRL_SESSION);
  // Enter through a real link, then use the SPA's own controls for every action.
  await page.setContent(` <a href="http://localhost:${process.env.PW_TEST_PORT ?? 3457}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${CTRL_SESSION}"]`);
  await expect(panel.locator('.session-panel-input .chat-input-textarea')).toBeVisible({ timeout: 20_000 });
  // The record and its history are in: the controls row has settled.
  await expect(panel.locator('.session-history')).toContainText('Answer 5.', { timeout: 20_000 });
  await expect(panel.locator('.session-panel-input [data-control-id="mode"] .mode-toggle-pill')).toBeVisible();
  return panel;
}

/** The menu settles inside the viewport (placement re-runs once its rows have laid out). */
async function fits(page: Page, menu: Locator) {
  await expect(async () => {
    const box = await menu.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  }).toPass({ timeout: 3000 });
}

test('a running session: no shortcut hint, the pill opens a menu of every mode and a pick switches', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes: SettingsWrites = { body: [] };
  await mockControlsSession(page, CTRL_SESSION, writes);
  const panel = await enterHome(page);
  const composer = panel.locator('.session-panel-input').last();
  const input = composer.locator('.chat-input-textarea').first();
  const pill = composer.locator('[data-control-id="mode"] .mode-toggle-pill');
  const menu = modeMenu(pill);
  await input.fill('Keep this unsent draft while the mode changes');

  // The pill is the mode's name alone.
  await expect(pill).toHaveText('Bypass');
  await expect(page.locator('.mode-toggle-pill-shortcut')).toHaveCount(0);
  await expect(pill).toHaveAttribute('aria-expanded', 'false');

  // Open, read, close, three times over: every mode, the current one checked.
  for (let i = 0; i < 3; i++) {
    await pill.click();
    await expect(menu).toBeVisible();
    await expect(pill).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('option')).toHaveCount(LABELS.length);
    await expect(menu.locator('.session-control-option-name')).toHaveText(LABELS);
    await expect(menu.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
    await expect(menu.locator('[role="option"][data-mode="bypass"]')).toHaveAttribute('aria-selected', 'true');
    await fits(page, menu);
    if (i === 0) {
      await fs_mkdir();
      await page.screenshot({ path: `${SHOTS}/1-session-menu.png` });
      // Escape closes the menu alone.
      await page.keyboard.press('Escape');
    } else if (i === 1) {
      // A press elsewhere closes it too.
      await panel.locator('.session-history').click({ position: { x: 20, y: 20 } });
    } else {
      // The pill is its own toggle.
      await pill.click();
    }
    await expect(menu).toHaveCount(0);
    await expect(input).toHaveValue('Keep this unsent draft while the mode changes');
  }
  expect(writes.body.filter((b) => 'mode' in b)).toEqual([]);

  // The current mode again: nothing is written.
  await pickMode(pill, 'bypass');
  expect(writes.body.filter((b) => 'mode' in b)).toEqual([]);

  // A pick switches: Plan in amber, then Auto.
  await pickMode(pill, 'plan');
  await expect(pill).toHaveText('Plan');
  await expect(pill).toHaveClass(/plan-active/);
  await expect.poll(() => writes.body.filter((b) => 'mode' in b).map((b) => b.mode)).toEqual(['plan']);
  await pill.click();
  await expect(menu.locator('[role="option"][data-mode="plan"]')).toHaveAttribute('aria-selected', 'true');
  await menu.locator('[role="option"][data-mode="auto"]').click();
  await expect(menu).toHaveCount(0);
  await expect(pill).toHaveText('Auto');
  await expect(pill).not.toHaveClass(/plan-active/);
  await expect.poll(() => writes.body.filter((b) => 'mode' in b).map((b) => b.mode)).toEqual(['plan', 'auto']);

  // From the keyboard: Enter opens it on the current mode, arrows move, Enter picks.
  await pill.focus();
  await page.keyboard.press('Enter');
  await expect(menu.locator('[role="option"][data-mode="auto"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('[role="option"][data-mode="bypass"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(pill).toHaveText('Bypass');

  // Shift+Tab in the box still steps the enabled cycle (Bypass → Plan).
  await input.click();
  await input.press('Shift+Tab');
  await expect(pill).toHaveText('Plan');
  await expect(input).toHaveValue('Keep this unsent draft while the mode changes');
  expect(errors).toEqual([]);
});

test('a phone-width column: the menu stays on screen', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await enterHome(page);
  await page.setViewportSize({ width: 390, height: 600 });
  const pill = panel.locator('.session-panel-input [data-control-id="mode"] .mode-toggle-pill');
  await expect(pill).toBeVisible();
  await pill.click();
  const menu = modeMenu(pill);
  await expect(menu.getByRole('option')).toHaveCount(LABELS.length);
  await fits(page, menu);
  await page.screenshot({ path: `${SHOTS}/2-phone-menu.png` });
  await menu.locator('[role="option"][data-mode="plan"]').click();
  await expect(pill).toHaveText('Plan');
});

test('the side-thread composer and the new-task draft pick their mode from the same menu', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await enterHome(page);

  // Side threads: the mode the next thread starts in.
  await directControl(panel, 'btw').click();
  const drawer = panel.locator('.side-question-popover--threads');
  await expect(drawer).toBeVisible();
  const threadPill = drawer.locator('.side-question-composer .mode-toggle-pill').first();
  await expect(threadPill.locator('.mode-toggle-pill-shortcut')).toHaveCount(0);
  await drawer.locator('.side-question-composer textarea').fill('An unsent aside');
  await threadPill.click();
  const menu = modeMenu(threadPill);
  await expect(menu.getByRole('option')).toHaveCount(LABELS.length);
  await fits(page, menu);
  await page.screenshot({ path: `${SHOTS}/3-side-thread-menu.png` });
  await menu.locator('[role="option"][data-mode="plan"]').click();
  // The pick is the drawer's own: it stays open, with its draft.
  await expect(drawer).toBeVisible();
  await expect(threadPill).toHaveText('Plan');
  await expect(drawer.locator('.side-question-composer textarea')).toHaveValue('An unsent aside');
  await threadPill.click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(drawer).toBeVisible();
  // With the menu gone, Escape is the drawer's own.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // The draft: the mode the task starts in.
  const draft = await openDraft(page);
  const draftPill = draft.locator('.draft-actions-bar .draft-mode-pill');
  await expect(draftPill).toHaveAttribute('data-mode', 'bypass');
  await expect(draftPill.locator('.mode-toggle-pill-shortcut')).toHaveCount(0);
  await draftPill.click();
  await expect(modeMenu(draftPill).getByRole('option')).toHaveCount(LABELS.length);
  await fits(page, modeMenu(draftPill));
  await page.screenshot({ path: `${SHOTS}/4-draft-menu.png` });
  await modeMenu(draftPill).locator('[role="option"][data-mode="accept"]').click();
  await expect(draftPill).toHaveAttribute('data-mode', 'accept');
  await expect(draftPill).toHaveText('Accept');
});

async function fs_mkdir(): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(SHOTS, { recursive: true });
}
