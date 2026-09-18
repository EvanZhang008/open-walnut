/**
 * Playwright browser test: a session panel that mounts with NO BOX must not
 * publish a zero header height, and the composer needs no height at all.
 *
 * The transcript is padded at the top by `--sp-header-h`, which the panel
 * measures from its header overlay and writes as an inline custom property.
 * Below 768px the home page hides every session column but the active one
 * (`display: none`), so a restored column can mount without a box, and
 * `offsetHeight` is 0 for such an element. Writing that 0 would make the
 * transcript pad by ~8px instead of ~84px, so the header covers the first rows
 * with no scroll position that can bring them out.
 *
 * The honest value while there is no box is NO value: the stylesheet's fallback
 * is a real header's height, and the panel re-measures when the box comes back.
 *
 * History: this guard was first written for `--sp-composer-h` (2026-09-17, a
 * boxless panel published 0px and the composer covered the newest rows). The
 * composer is in flow now (see composer-in-flow-helpers.ts), so that variable no
 * longer exists and the failure it guarded against is impossible by layout;
 * the third block below pins exactly that after the reveal.
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

/** What the panel published, and how the transcript and composer actually lay out. */
async function readPanel(page: Page, id: string) {
  return page.evaluate((sid) => {
    const panel = document.querySelector<HTMLElement>(`.session-panel[data-session-id="${sid}"]`);
    if (!panel) return null;
    const col = panel.closest<HTMLElement>('.main-page-session-column');
    const hist = panel.querySelector<HTMLElement>('.session-history');
    const header = panel.querySelector<HTMLElement>('.session-panel-header');
    const input = panel.querySelector<HTMLElement>('.session-panel-input');
    // The header var feeds the transcript's padding-top when the transcript is
    // the body's first child, else the margin-top of that first child (the
    // supervision bar / cron card render ahead of it). Read whichever rule
    // applies; computed lengths resolve even while the column is display:none.
    const body = panel.querySelector<HTMLElement>('.session-panel-body');
    const first = body?.firstElementChild as HTMLElement | null;
    const receiver = first && first !== hist ? first : hist;
    const pushDown = receiver
      ? parseFloat(getComputedStyle(receiver)[receiver === hist ? 'paddingTop' : 'marginTop'])
      : null;
    return {
      columnDisplay: col ? getComputedStyle(col).display : null,
      headerVar: panel.style.getPropertyValue('--sp-header-h'),
      actualHeaderH: header ? Math.round(header.offsetHeight) : null,
      actualComposerH: input ? Math.round(input.offsetHeight) : null,
      pushDown,
      scrollerBottom: hist ? hist.getBoundingClientRect().bottom : null,
      composerTop: input ? input.getBoundingClientRect().top : null,
      composerPosition: input ? getComputedStyle(input).position : null,
    };
  }, id);
}

test.describe('Header height variable, a panel with no box', () => {
  test('a column hidden by the narrow layout publishes no height, re-measures when shown, and never measures the composer', async ({ page }) => {
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
    expect(hidden!.actualHeaderH, 'an element with no box measures zero').toBe(0);
    // The bug: that zero reaching the stylesheet.
    expect(hidden!.headerVar, 'a boxless panel must publish nothing, not 0px').not.toBe('0px');
    // …and the fallback is a real header's height, not a bare 8px.
    expect(hidden!.pushDown!, 'the transcript keeps room for a header').toBeGreaterThan(40);

    // Shown: the real measurement takes over.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(2500);
    const shown = await readPanel(page, HIDDEN);
    expect(shown!.columnDisplay).not.toBe('none');
    expect(shown!.actualHeaderH!).toBeGreaterThan(30);
    expect(parseFloat(shown!.headerVar), 'the published height is the measured one')
      .toBeCloseTo(shown!.actualHeaderH!, 0);
    expect(shown!.pushDown!, 'and the transcript is pushed down by it')
      .toBeGreaterThanOrEqual(shown!.actualHeaderH!);

    // The composer: nothing to measure, nothing to get wrong. A real composer
    // with a real box, and the scroller ends exactly where it starts.
    expect(shown!.actualComposerH!).toBeGreaterThan(40);
    expect(shown!.composerPosition, 'the composer is a flow sibling').not.toBe('absolute');
    expect(Math.abs(shown!.scrollerBottom! - shown!.composerTop!), 'scroller ends at the composer').toBeLessThanOrEqual(1);
  });
});
