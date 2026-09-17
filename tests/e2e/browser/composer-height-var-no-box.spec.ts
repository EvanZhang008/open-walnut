/**
 * Playwright browser test: a session panel that mounts with NO BOX must not
 * publish a zero composer height.
 *
 * The transcript is padded at the bottom by `--sp-composer-h`, which the panel
 * measures from its composer overlay and writes as an inline custom property.
 * Below 768px the home page hides every session column but the active one
 * (`display: none`), so a restored column can mount without a box — and
 * `offsetHeight` is 0 for such an element. Writing that 0 makes the transcript
 * pad by ~36px instead of ~150px, so the composer covers the newest rows with no
 * scroll position that can bring them out. Measured before the fix, on a real
 * panel: `--sp-composer-h: 0px`, `padding-bottom: 36px`.
 *
 * The honest value while there is no box is NO value: the stylesheet's fallback
 * is a real composer's height, and the panel re-measures when the box comes back.
 */
import { test, expect, type Page } from '@playwright/test';

const VISIBLE = 'pw-heightvar-visible-session';
const HIDDEN = 'pw-heightvar-hidden-session';

function messages(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `${prefix} row ${i}\n\n${'padding text that makes the row tall enough to scroll '.repeat(3)}`,
    msgId: `${prefix}-m${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

async function mock(page: Page, id: string, title: string) {
  const rows = messages(id, 40);
  await page.route(`**/api/sessions/${id}/history**`, (route) => route.fulfill({
    json: {
      messages: rows,
      total: rows.length,
      ...(route.request().url().includes('source=streams') ? {} : { cursor: rows.length }),
      delta: false,
    },
  }));
  await page.route(`**/api/sessions/${id}`, (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    return route.fulfill({
      json: {
        session: {
          claudeSessionId: id, taskId: `${id}-task`, project: 'Walnut',
          process_status: 'idle', mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(), messageCount: rows.length, title,
        },
      },
    });
  });
}

/** What the panel published, and what the transcript actually pads by. */
async function readPanel(page: Page, id: string) {
  return page.evaluate((sid) => {
    const panel = document.querySelector<HTMLElement>(`.session-panel[data-session-id="${sid}"]`);
    if (!panel) return null;
    const col = panel.closest<HTMLElement>('.main-page-session-column');
    const hist = panel.querySelector<HTMLElement>('.session-history');
    const input = panel.querySelector<HTMLElement>('.session-panel-input');
    return {
      columnDisplay: col ? getComputedStyle(col).display : null,
      inlineVar: panel.style.getPropertyValue('--sp-composer-h'),
      actualComposerH: input ? Math.round(input.offsetHeight) : null,
      paddingBottom: hist ? Math.round(parseFloat(getComputedStyle(hist).paddingBottom)) : null,
    };
  }, id);
}

test.describe('Composer height variable — a panel with no box', () => {
  test('a column hidden by the narrow layout publishes no height, and re-measures when shown', async ({ page }) => {
    await mock(page, VISIBLE, 'Visible column');
    await mock(page, HIDDEN, 'Hidden column');
    await page.addInitScript(([a, b]) => {
      sessionStorage.setItem('open-walnut-home-session-columns',
        JSON.stringify([{ id: a, locked: false }, { id: b, locked: false }]));
    }, [HIDDEN, VISIBLE]);

    // Mount BOTH panels in the narrow layout, where one column has no box.
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator(`.session-panel[data-session-id="${HIDDEN}"]`)).toHaveCount(1, { timeout: 20000 });
    await page.waitForTimeout(3000);

    const hidden = await readPanel(page, HIDDEN);
    expect(hidden, 'the hidden panel must still be mounted').not.toBeNull();
    expect(hidden!.columnDisplay, 'this layout is the one that hides a column').toBe('none');
    expect(hidden!.actualComposerH, 'an element with no box measures zero').toBe(0);
    // The bug: that zero reaching the stylesheet.
    expect(hidden!.inlineVar, 'a boxless panel must publish nothing, not 0px').not.toBe('0px');
    // …and the fallback is a real composer's height, not a bare fade.
    expect(hidden!.paddingBottom!, 'the transcript keeps room for a composer').toBeGreaterThan(80);

    // Shown: the real measurement takes over.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(2500);
    const shown = await readPanel(page, HIDDEN);
    expect(shown!.columnDisplay).not.toBe('none');
    expect(shown!.actualComposerH!).toBeGreaterThan(40);
    expect(parseFloat(shown!.inlineVar), 'the published height is the measured one')
      .toBeCloseTo(shown!.actualComposerH!, 0);
    expect(shown!.paddingBottom!, 'and the transcript pads by it')
      .toBeGreaterThan(shown!.actualComposerH!);
  });
});
