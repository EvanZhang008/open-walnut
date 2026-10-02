// Shared fixture and measurements for the composer controls in Chromium and WebKit.
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs/promises';

export const CTRL_SESSION = 'pw-composer-controls';
export const CTRL_FILLER = 'pw-composer-controls-filler';
export const SHOT_DIR = process.env.CTRL_SHOT_DIR ?? '/tmp/composer-plus';

function rows(prefix: string, n: number, inputTokens = 90_000) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    msgId: `${prefix}-m${i}`,
    text: i % 2 === 0 ? `Question ${i}` : `Answer ${i}.`,
    ...(i === n - 1 && inputTokens > 0 ? { model: 'claude-fable-5-1', usage: { input_tokens: inputTokens } } : {}),
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

/** Requests the page made that change session settings, for scenario 4. */
export interface SettingsWrites { body: Record<string, unknown>[] }

/** One idle session whose composer shows every control. */
export async function mockControlsSession(page: Page, id: string, writes?: SettingsWrites, inputTokens = 90_000): Promise<void> {
  const messages = rows(id, 6, inputTokens);
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

/** A third column, for a row too tight to hold the model pill's percentage. */
export const CTRL_FILLER_2 = 'pw-composer-controls-filler-2';

/** Viewport at which two columns condense the controls row (1100 no longer
 *  does: the home page gives the columns more room than it did on 2026-09-26). */
export const NARROW_WIDTH = 900;

/** Open `id` as the only column (wide) or beside filler columns (narrow); the
 *  narrow layout takes an explicit viewport width and column list. */
export async function openControlsSession(
  page: Page,
  opts: { narrow: boolean; width?: number; columns?: string[] },
): Promise<Locator> {
  const ids = opts.columns ?? (opts.narrow ? [CTRL_SESSION, CTRL_FILLER] : [CTRL_SESSION]);
  await page.addInitScript((list) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify(list.map((id: string) => ({ id, locked: false }))));
  }, ids);
  await page.setViewportSize({ width: opts.width ?? (opts.narrow ? NARROW_WIDTH : 1600), height: 800 });
  await page.goto('/');
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${CTRL_SESSION}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('.session-history')).toContainText('Answer 5.', { timeout: 20_000 });
  await expect(barOf(panel)).toBeVisible();
  return panel;
}

/**
 * Column widths that put the controls row in each of its three shapes. The row
 * gets the column's width minus 140px (the mic/send cluster and padding), the
 * condensed pills measure Bypass 56 + gap 4 + "Fable" 37 = 97, and " 45%" adds
 * 28 plus the 2px fit margin: 260px leaves 120px (name only), 220px leaves
 * 80px (the model moves into the "..." menu). The home page's own column count
 * is a server setting the fixture does not change, so the tight shapes are
 * reached by clamping the column instead of opening a third one.
 */
export const COLUMN_NAME_ONLY = 260;
export const COLUMN_MODEL_IN_MENU = 220;

/** Clamp every session column to `px`, or lift the clamp with null. */
export async function clampColumn(page: Page, px: number | null): Promise<void> {
  await page.evaluate((width) => {
    const id = 'pw-column-clamp';
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (!style) { style = document.createElement('style'); style.id = id; document.head.appendChild(style); }
    style.textContent = width == null ? '' : `.main-page-session-column {
      width: ${width}px !important; max-width: ${width}px !important; min-width: 0 !important; flex: 0 0 ${width}px !important;
    }`;
  }, px);
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

/**
 * The frame before the row has been measured shows every control, so the CSS
 * fallback has to CONTAIN that row rather than let it spill. Forces all controls
 * visible and reads the geometry in the same synchronous block (React resets it
 * on the next measure), then reports whether the row stacked or ran under the
 * mic/send cluster — the shape of the bug this whole change replaces.
 */
export async function forceAllVisibleGeometry(panel: Locator): Promise<{ lines: number; overhang: number }> {
  const micBox = await panel.locator('.chat-input-controls .mic-btn-wrapper').first().boundingBox();
  return barOf(panel).evaluate((bar, mic) => {
    const items = [...bar.querySelectorAll<HTMLElement>('[data-control-id]')];
    for (const el of items) el.dataset.hidden = 'false';
    const box = bar.getBoundingClientRect();
    const tops = new Set(items.map((el) => Math.round(el.getBoundingClientRect().top)));
    return { lines: tops.size, overhang: mic ? Math.round(box.right - mic.x) : -1 };
  }, micBox);
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
