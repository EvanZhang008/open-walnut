import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
import { mockControlsSession, CTRL_SESSION } from './composer-controls-overflow-helpers';
import { openDraft } from './draft-helpers';

test.use({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 });

async function enterHome(page: Page, sid = CTRL_SESSION) {
  await page.addInitScript((id) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]));
  }, sid);
  // Enter through a real link, then use the SPA's own controls for every action.
  await page.setContent(` <a href="http://localhost:${process.env.PW_TEST_PORT ?? 3457}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
  await expect(panel.locator('.session-panel-input .chat-input-textarea')).toBeVisible({ timeout: 20_000 });
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

test('one Reference row, More flyout and direct Note/btw keep the main draft through repeated use', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await enterHome(page);
  const composer = panel.locator('.session-panel-input').last();
  const input = composer.locator('.chat-input-textarea').first();
  const add = composer.locator('.chat-plus-btn').first();
  const mainMenu = composer.locator('.chat-plus-group > .chat-plus-menu').first();
  const more = page.getByRole('menu', { name: 'More composer actions' });
  await input.fill('Keep this unsent draft: review the long release checklist');
  for (let i = 0; i < 3; i++) {
    await add.click();
    await expect(mainMenu.getByRole('menuitem', { name: /@\s*Reference/, exact: true })).toHaveCount(1);
    await expect(mainMenu.locator('[data-add-control="note"], [data-add-control="btw"]')).toHaveCount(0);
    await expect(mainMenu.locator('[data-action-id="compact-context"]')).toHaveCount(0);
    await mainMenu.getByRole('menuitem', { name: 'More', exact: true }).click();
    await expect(more).toBeVisible();
    await expect(more.getByRole('menuitem', { name: /Compact context/ })).toBeVisible();
    await fits(page, more);
    await expect(mainMenu).toBeVisible();
    // A disabled item is still readable and does not dismiss either layer.
    const recall = more.getByRole('menuitem', { name: /Recall:/ });
    // Playwright waits for aria-disabled rows to become enabled; test their no-op directly.
    await recall.dispatchEvent('click');
    await expect(more).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(more).toHaveCount(0);
    await expect(mainMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(mainMenu).toHaveCount(0);
    await expect(input).toHaveValue('Keep this unsent draft: review the long release checklist');
  }
  await composer.locator('.composer-direct-control[data-add-control="btw"]').click();
  await expect(composer.locator('.side-question-popover--threads')).toBeVisible();
  await composer.locator('.side-question-composer textarea').fill('A separate unsent aside');
  const btw = composer.locator('.composer-direct-control[data-add-control="btw"]');
  await expect(btw).toHaveAttribute('aria-expanded', 'true');
  await btw.click();
  await expect(composer.locator('.side-question-popover--threads')).toHaveCount(0);
  await expect(btw).toHaveAttribute('aria-expanded', 'false');
  await btw.click();
  await expect(composer.locator('.side-question-composer textarea')).toHaveValue('A separate unsent aside');
  await page.keyboard.press('Escape');
  await composer.locator('.composer-direct-control[data-add-control="note"]').click();
  await expect(composer.locator('.session-notes-editor')).toBeVisible();
  const note = composer.locator('.composer-direct-control[data-add-control="note"]');
  await expect(note).toHaveAttribute('aria-expanded', 'true');
  await note.click();
  await expect(composer.locator('.session-notes-editor')).toHaveCount(0);
  await note.click();
  await expect(composer.locator('.session-notes-editor')).toBeVisible();
  await expect(input).toHaveValue('Keep this unsent draft: review the long release checklist');
  await fs.mkdir('/tmp/composer-lean-menu', { recursive: true });
  await composer.screenshot({ path: '/tmp/composer-lean-menu/direct-controls.png' });
  expect(errors).toEqual([]);
});

test('Reference picks files and folders from the unified picker without dropping prose', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  await page.route('**/api/files/list?**', (route) => route.fulfill({ json: {
    path: '/tmp', entries: [{ name: 'release-guide.md', type: 'file', size: 23000 }, { name: 'reports', type: 'dir' }],
  } }));
  const panel = await enterHome(page);
  const composer = panel.locator('.session-panel-input').last();
  const input = composer.locator('.chat-input-textarea').first();
  // The fixture's seeded tasks share the very same All picker with files and folders.
  await input.fill('Review ');
  await composer.locator('.chat-plus-btn').first().click();
  await composer.getByRole('menuitem', { name: /@\s*Reference/, exact: true }).click();
  const taskRow = composer.locator('.mention-palette .mention-row-task').first();
  await expect(taskRow).toBeVisible();
  await taskRow.click();
  await expect(input).toHaveValue(/^Review @\[.+\] $/);
  for (const kind of ['file', 'folder']) {
    await input.fill('Review ');
    await composer.locator('.chat-plus-btn').first().click();
    await composer.getByRole('menuitem', { name: /@\s*Reference/, exact: true }).click();
    const palette = composer.locator('.mention-palette');
    await expect(palette).toBeVisible();
    if (kind === 'file') await palette.locator('.mention-row', { hasText: 'release-guide.md' }).click();
    else {
      const folder = palette.locator('.mention-row[title="/tmp/reports"]');
      await folder.hover();
      await folder.locator('.mention-pick-btn').click();
    }
    await expect(input).toHaveValue(kind === 'file' ? 'Review @/tmp/release-guide.md ' : 'Review @/tmp/reports ');
  }
});

test('short draft menu and phone composer retain reachable direct controls and scrollable More', async ({ page }) => {
  await mockControlsSession(page, CTRL_SESSION);
  const panel = await enterHome(page);
  await page.setViewportSize({ width: 390, height: 600 });
  const composer = panel.locator('.session-panel-input').last();
  await expect(composer.locator('.composer-direct-control[data-add-control="btw"]')).toBeVisible();
  await expect(composer.locator('.composer-direct-control[data-add-control="note"]')).toBeVisible();
  await composer.locator('.chat-plus-btn').first().click();
  await composer.getByRole('menuitem', { name: 'More', exact: true }).click();
  await fits(page, page.getByRole('menu', { name: 'More composer actions' }));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1100, height: 420 });
  const draft = await openDraft(page);
  await draft.locator('.chat-plus-btn').click();
  const menu = draft.locator('.chat-plus-group > .chat-plus-menu');
  await expect(menu.getByRole('menuitem', { name: /@\s*Reference/, exact: true })).toBeVisible();
  await fits(page, menu);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});
