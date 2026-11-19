// Opening btw on a session that keeps a side thread, at every column width.
//
// 2026-11-18: clicking btw took the whole session panel down ("Maximum update depth
// exceeded"). The side-thread drawer opens INSIDE the composer's controls bar, with a
// composer of its own; the bar measured that composer's spacer as its own row's, so
// its room changed with its own fold and condense and it flipped between the two on
// every render. It needed a kept thread (the drawer opens on its conversation and
// composer) and a column near one width (480px in Chromium here; WebKit's fonts move
// it), so the wide single-column check never saw it. This walks the widths.
// Runs in both engines: `--project chromium`, and `PW_WEBKIT=1 --project webkit`.
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  CTRL_SESSION, CTRL_FILLER, mockControlsSession, openControlsSession, clampColumn, directControl,
  addButton, addRow, barOf,
} from './composer-controls-overflow-helpers';

const THREAD_SID = 'pw-btw-thread-fork';
/** The thread the report showed, as the session kept it. */
const KEPT_THREAD = {
  id: 'sth-1794513692384-37a72a2c', sessionId: CTRL_SESSION,
  question: 'u are talki ng about the report table right, before I rmemebr we only has in progress and compelte right',
  threadSessionId: THREAD_SID, title: 'Report table status options',
  createdAt: '2026-11-12T20:01:32.433Z', archived: false,
};

async function mockKeptThread(page: Page): Promise<void> {
  await page.route(`**/api/sessions/${CTRL_SESSION}/side-threads**`, (route) => route.fulfill({
    json: { threads: [KEPT_THREAD], legacy: [] },
  }));
  // The thread's own fork session: a record and a short conversation.
  await mockControlsSession(page, THREAD_SID);
}

/** Click btw where it is now: its direct button, else the "+" menu's row. A try that
 *  finds neither (the row is folding or unfolding it) tries again; an open popover ends it. */
async function openBtw(page: Page, panel: Locator, popover: Locator): Promise<void> {
  await expect(async () => {
    if (await popover.isVisible()) return;
    if (await page.locator('[data-error-region]').count()) return; // the caller reports it
    const direct = directControl(panel, 'btw');
    if (await direct.isVisible()) await direct.click({ timeout: 1_000 });
    else {
      if (!await addRow(panel, 'btw').isVisible()) await addButton(panel).click({ timeout: 1_000 });
      await addRow(panel, 'btw').click({ timeout: 1_000 });
    }
    await expect(popover).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

/** The row's shape across a few frames: one value means it settled. */
async function rowShapes(page: Page): Promise<string[]> {
  return page.evaluate(async (id) => {
    const bar = document.querySelector(`.main-page-session-column .session-panel[data-session-id="${id}"] .composer-controls-bar`);
    const shapes = new Set<string>();
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      shapes.add(`${bar?.getAttribute('data-direct-folded') ?? 'open'}|${bar?.classList.contains('is-condensed')}`);
    }
    return [...shapes];
  }, CTRL_SESSION);
}

test('btw opens its kept thread at every column width, and the panel and its controls row stay steady', async ({ page }) => {
  test.setTimeout(240_000);
  const loops: string[] = [];
  page.on('console', (m) => { if (/Maximum update depth|render error caught by boundary|kept changing its shape/.test(m.text())) loops.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => loops.push(e.message));
  await mockControlsSession(page, CTRL_SESSION);
  await mockControlsSession(page, CTRL_FILLER);
  await mockKeptThread(page);
  // Two columns, as on the report (the session beside another one).
  const panel = await openControlsSession(page, { narrow: true, width: 1280 });
  const popover = panel.locator('.session-panel-input .side-question-popover--threads');
  // The steps and waits of the run that reproduced it every time: the loop needed
  // the click to land while the row was still taking the new width's shape, as a
  // click does while a window or a column is being resized. Keep them as they are.
  const crashedAt: string[] = [];
  for (let width = 240; width <= 640; width += 8) {
    await clampColumn(page, width, { exact: true });
    await page.waitForTimeout(150);
    // btw is a direct button, or folded into "+" on a tight row; a slower engine may
    // still be folding or unfolding it, so each try takes the row as it is then.
    await openBtw(page, panel, popover);
    await page.waitForTimeout(400);
    if (await page.locator('[data-error-region]').count() || loops.length) { crashedAt.push(`${width}px`); break; }
    // Each width really opened it (a missed click would let the width pass untested).
    if (!await popover.isVisible()) { crashedAt.push(`${width}px: btw did not open`); break; }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  expect(crashedAt, `a part of the panel crashed (or its row looped) on opening btw: ${loops.join(' | ')}`).toEqual([]);
  expect(loops).toEqual([]);

  // At the width of the report's crash, btw shows the kept thread and the row holds still.
  await clampColumn(page, 480, { exact: true });
  await page.waitForTimeout(150);
  await openBtw(page, panel, popover);
  await expect(popover.locator('.side-thread-chip-title')).toHaveText('Report table status options');
  expect(await rowShapes(page), 'the controls row kept changing with btw open').toHaveLength(1);
  const threadBox = popover.locator('.side-question-composer textarea');
  await threadBox.fill('a follow-up typed in the thread');
  await expect(threadBox).toHaveValue('a follow-up typed in the thread');
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(page.locator('[data-error-region]')).toHaveCount(0);
  expect(loops).toEqual([]);

  // Still a working composer afterwards: the row is there and the box takes text.
  await clampColumn(page, null);
  await expect(barOf(panel)).toBeVisible();
  const box = panel.locator('.session-panel-input textarea').first();
  await box.fill('still typing after btw');
  await expect(box).toHaveValue('still typing after btw');
});
