/**
 * The session composer's controls row and its "..." overflow menu.
 *
 * Reported (2026-09-19, Mac app screenshot): in a narrow session column the five
 * pills (mode, reply style, btw, note, model) wrapped onto four rows and pushed
 * the composer up the panel. The user picked the overflow shape: keep the
 * most-used controls on one row, put the rest behind one button, and leave a wide
 * column exactly as it is.
 *
 * Scenario matrix (both engines — the Mac app is a WKWebView):
 *  1. wide column: every pill on ONE row, no "..." button (today's look);
 *  2. narrow column: ONE row, the mode pill still there, a "..." button, and the
 *     row is no taller than a single pill;
 *  3. the menu lists the hidden controls, each row naming its control and
 *     carrying the live pill's own state text, and stays inside the viewport;
 *  4. a plain row (reply style) acts on the real control: the pill's own label
 *     flips, which proves the click reached the pill and not a copy of it;
 *  5. an anchored row (model) pins its pill onto the row and opens its picker
 *     against it;
 *  6. Escape and an outside click close the menu;
 *  7. widening the column brings every pill back and removes the button, and
 *     narrowing it again collapses (no oscillation, no wrap at any width).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs/promises';

export const CTRL_SESSION = 'pw-composer-controls';
export const CTRL_FILLER = 'pw-composer-controls-filler';
export const SHOT_DIR = process.env.CTRL_SHOT_DIR ?? '/tmp/composer-controls';

function rows(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    msgId: `${prefix}-m${i}`,
    text: i % 2 === 0 ? `Question ${i}` : `Answer ${i}.`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

/** Requests the page made that change session settings, for scenario 4. */
export interface SettingsWrites { body: Record<string, unknown>[] }

/** One idle session whose composer shows every control. */
export async function mockControlsSession(page: Page, id: string, writes?: SettingsWrites): Promise<void> {
  const messages = rows(id, 6);
  await page.route(`**/api/sessions/${id}/history**`, (route) => route.fulfill({
    json: { messages, total: messages.length, cursor: messages.length, delta: false },
  }));
  await page.route(`**/api/sessions/${id}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    if (request.method() === 'PATCH' || request.method() === 'PUT') {
      writes?.body.push(JSON.parse(request.postData() ?? '{}'));
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      json: {
        session: {
          claudeSessionId: id, taskId: `${id}-task`, project: 'Walnut',
          process_status: 'idle', mode: 'bypass', engine: 'claude',
          model: 'claude-fable-5-1', effort: 'high', effectiveEffort: 'high',
          output_mode: 'rich', startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(), messageCount: messages.length,
          title: 'Composer controls', cwd: '/tmp',
        },
      },
    });
  });
}

/** Open `id` as the only column (wide) or beside a filler column (narrow). */
export async function openControlsSession(page: Page, opts: { narrow: boolean }): Promise<Locator> {
  const ids = opts.narrow ? [CTRL_SESSION, CTRL_FILLER] : [CTRL_SESSION];
  await page.addInitScript((list) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify(list.map((id: string) => ({ id, locked: false }))));
  }, ids);
  await page.setViewportSize({ width: opts.narrow ? 1100 : 1600, height: 800 });
  await page.goto('/');
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${CTRL_SESSION}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('.session-history')).toContainText('Answer 5.', { timeout: 20_000 });
  await expect(barOf(panel)).toBeVisible();
  return panel;
}

export const barOf = (panel: Locator) => panel.locator('.composer-controls-bar').last();
export const overflowBtn = (panel: Locator) => panel.getByTestId('composer-overflow-btn');
export const controlOf = (panel: Locator, id: string) => barOf(panel).locator(`[data-control-id="${id}"]`);

/** Ids currently ON the row, and the row's height in pill-rows. */
export async function rowState(panel: Locator): Promise<{ visible: string[]; hidden: string[]; lines: number; height: number }> {
  return barOf(panel).evaluate((bar) => {
    const items = [...bar.querySelectorAll<HTMLElement>('[data-control-id]')];
    const visible = items.filter((el) => el.dataset.hidden !== 'true');
    const tops = new Set(visible.map((el) => Math.round(el.getBoundingClientRect().top)));
    return {
      visible: visible.map((el) => el.dataset.controlId!),
      hidden: items.filter((el) => el.dataset.hidden === 'true').map((el) => el.dataset.controlId!),
      lines: tops.size,
      height: Math.round(bar.getBoundingClientRect().height),
    };
  });
}

/** The row holds one line of pills and never spills past the mic/send cluster. */
export async function expectSingleRow(panel: Locator): Promise<void> {
  const state = await rowState(panel);
  expect(state.lines, `the controls wrapped onto ${state.lines} lines`).toBeLessThanOrEqual(1);
  const [bar, mic] = await Promise.all([
    barOf(panel).boundingBox(),
    panel.locator('.chat-input-controls .mic-btn-wrapper').first().boundingBox(),
  ]);
  expect(bar).toBeTruthy();
  if (mic) expect(bar!.x + bar!.width, 'the controls row runs under the mic button').toBeLessThanOrEqual(mic.x + 1);
}

/** Every hidden control has a row that NAMES it and repeats whatever its live
 *  pill says (dropped only when the pill just repeats the name). Reading the
 *  value off the pill is the point: a second copy would drift. */
export async function expectMenuNamesHidden(panel: Locator, hidden: string[], names: Record<string, string>): Promise<void> {
  const page = panel.page();
  for (const id of hidden) {
    const row = page.getByTestId(`composer-overflow-item-${id}`);
    await expect(row.locator('.composer-overflow-item-name')).toHaveText(names[id]!);
    const pillText = await controlOf(panel, id).evaluate((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
    const sameAsName = pillText.toLowerCase().replace(/[^a-z0-9]+/g, '') === names[id]!.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (sameAsName) {
      await expect(row.locator('.composer-overflow-item-value')).toHaveCount(0);
    } else {
      await expect(row.locator('.composer-overflow-item-value')).toHaveText(pillText);
    }
  }
}

/** The names SessionPanel gives its five controls. */
export const CTRL_NAMES: Record<string, string> = {
  mode: 'Mode', model: 'Model', output: 'Reply style', btw: 'Side thread', note: 'Note',
};

/** Crop the composer block. `lift` reaches further up the panel, for a shot that
 *  has to include the menu (it opens upward, over the transcript). */
export async function shootComposer(panel: Locator, name: string, lift = 90): Promise<void> {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const box = await panel.boundingBox();
  const bar = await barOf(panel).boundingBox();
  if (!box || !bar) return;
  const engine = panel.page().context().browser()?.browserType().name() ?? 'browser';
  const top = Math.max(box.y, bar.y - lift);
  await panel.page().screenshot({
    path: `${SHOT_DIR}/${engine}-${name}.png`,
    clip: { x: box.x, y: top, width: box.width, height: Math.min(box.y + box.height - top, lift + 130) },
  });
}
