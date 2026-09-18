/**
 * The session composer is a flow sibling BELOW the transcript scroller, not an
 * overlay on top of it, so the scroller, and with it the native scrollbar, end
 * exactly where the composer starts.
 *
 * Reported (2026-09-18, screenshot of the Mac app, after several follow-the-
 * bottom fixes): "the last line of text should be the end; the scroll bar must
 * not run on below it and make people think there is more". Measured on the
 * live panel at the time: scrolled to the end, `.session-history` reached the
 * panel's bottom edge 213px under the composer, its padding-bottom was the
 * composer's height + 28px fade + 8px, and the thumb ran 36px past the last row
 * before the composer's glass mask swallowed it. The thumb's END was never on
 * screen, which is the whole signal a scrollbar exists to give.
 *
 * Scenario matrix (each engine, the Mac app is WebKit, runs every row):
 *  1. at rest, scrolled to the end: scroller bottom == composer top, no bottom
 *     padding worth the name, the newest row fully on screen, and EVERY row of
 *     composer chrome (notes bar, recap tip, input card) below the scroller's
 *     end, so the scrollbar stops above all of it;
 *  2. the composer GROWS under a following reader (a multi-line draft): the
 *     scroller shrinks by the same height and the newest row stays on screen,
 *     closed within a frame, not after the 250ms debounce (the old overlay's
 *     useHeightVar pin did this synchronously; the flow layout must not regress
 *     into a per-newline flash);
 *  3. the composer shrinks back: still at the end;
 *  4. the reader scrolls up: the ↓ arrow appears ABOVE the composer, never under it;
 *  5. popovers anchored to the composer (the "@" mention palette) still open UPWARD
 *     over the transcript and stay on top of the header where they reach it:
 *     the overlay used to give the composer a stacking context above the
 *     header, and the flow layout keeps that ordering (z-index on the wrapper).
 */
import { expect, type Locator, type Page } from '@playwright/test';

export const FLOW_SESSION = 'pw-composer-flow-session';
const ROWS = 60;

/** A CJK table cell keeps the wide-glyph line-height path in the mix (the two characters spell "Chinese"). */
const CJK_CELL = '\u4e2d\u6587';

function rows(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    msgId: `${prefix}-m${i}`,
    text: i % 2 === 0
      ? `Question ${i}: where does the scroller end? The newest row must stay fully visible above the composer.`
      : `## Answer ${i}\n\nParagraphs, a table and code, like a real reply.\n\n| Check | Result |\n| --- | --- |\n| ${CJK_CELL} | Ready |\n| Layout | Visible |\n\n\`\`\`ts\nconst row = ${i};\n\`\`\`\n\nFinal line of answer ${i}.`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

/** Mock one dense session (history + detail) so the geometry is deterministic. */
export async function mockFlowSession(page: Page, id = FLOW_SESSION): Promise<void> {
  const messages = rows(id, ROWS);
  await page.route(`**/api/sessions/${id}/history**`, (route) => route.fulfill({
    json: {
      messages,
      total: messages.length,
      ...(route.request().url().includes('source=streams') ? {} : { cursor: messages.length }),
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
          lastActiveAt: new Date().toISOString(), messageCount: messages.length,
          title: 'Composer in flow',
          // A cwd is what lets the "@" mention palette open (scenario 5 needs
          // the tallest popover the composer owns).
          cwd: '/tmp',
          // A sticky note docks its bar above the input card, and a recap adds the
          // one-line tip under it: the layout both reports were taken from (note +
          // recap + composer under the newest row).
          human_note: 'sticky note above the composer',
          recap: 'One line of what just happened, shown above the composer.',
          recapAt: new Date().toISOString(),
        },
      },
    });
  });
}

/** Restore the session as a home column and wait for the newest row. */
export async function openFlowSession(page: Page, id = FLOW_SESSION): Promise<Locator> {
  await page.addInitScript((sid) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sid, locked: false }]));
  }, id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('.session-history')).toContainText(`Final line of answer ${ROWS - 1}`, { timeout: 20_000 });
  await expectAtEnd(panel);
  return panel;
}

export type Geometry = {
  gap: number;
  scrollerBottom: number;
  composerTop: number;
  composerPosition: string;
  paddingBottom: number;
  lastRowBottom: number | null;
  chrome: Array<{ label: string; top: number }>;
  arrowVisible: boolean;
  arrowBottom: number | null;
};

export async function geometry(panel: Locator): Promise<Geometry> {
  return panel.evaluate((p) => {
    const hist = p.querySelector<HTMLElement>('.session-history')!;
    const input = p.querySelector<HTMLElement>('.session-panel-input')!;
    const h = hist.getBoundingClientRect();
    const i = input.getBoundingClientRect();
    // The newest in-flow row: skip the sticky arrow and anything without a box.
    const rows = Array.from(hist.children).filter((c) =>
      !c.classList.contains('scroll-to-bottom-btn') && c.getBoundingClientRect().height > 0);
    const last = rows[rows.length - 1];
    const arrow = hist.querySelector<HTMLElement>('.scroll-to-bottom-btn');
    return {
      gap: hist.scrollHeight - hist.scrollTop - hist.clientHeight,
      scrollerBottom: h.bottom,
      composerTop: i.top,
      composerPosition: getComputedStyle(input).position,
      paddingBottom: parseFloat(getComputedStyle(hist).paddingBottom),
      lastRowBottom: last ? last.getBoundingClientRect().bottom : null,
      // Every row of chrome the composer block can carry, in DOM order.
      chrome: ([
        ['notes bar', '.session-notes'],
        ['send error', '.session-panel-input > .text-xs'],
        ['recap tip', '.session-recap-tip'],
        ['thread chip', '.session-panel-input .thread-anchor-chip'],
        ['image strip', '.session-panel-input .chat-image-previews'],
        ['queue bar', '.session-panel-input .chat-queue-indicator'],
        ['input card', '.session-panel-input .chat-input-box'],
      ] as const).flatMap(([label, sel]) => {
        const el = p.querySelector<HTMLElement>(sel);
        return el ? [{ label, top: el.getBoundingClientRect().top }] : [];
      }),
      arrowVisible: !!arrow && arrow.classList.contains('visible'),
      arrowBottom: arrow ? arrow.getBoundingClientRect().bottom : null,
    };
  });
}

export async function expectAtEnd(panel: Locator): Promise<void> {
  await expect.poll(async () => (await geometry(panel)).gap, { timeout: 10_000 }).toBeLessThanOrEqual(1);
}

/** Row 1 of the matrix: the box the scrollbar is drawn along ends at the composer. */
export async function expectScrollerEndsAtComposer(panel: Locator): Promise<Geometry> {
  const g = await geometry(panel);
  expect(g.composerPosition, 'the composer is a flow sibling, not an overlay').not.toBe('absolute');
  expect(Math.abs(g.scrollerBottom - g.composerTop), `scroller bottom ${g.scrollerBottom} vs composer top ${g.composerTop}`).toBeLessThanOrEqual(1);
  expect(g.paddingBottom, 'no composer-sized padding under the transcript').toBeLessThanOrEqual(16);
  expect(g.lastRowBottom, 'a newest row is rendered').not.toBeNull();
  expect(g.lastRowBottom!, 'the newest row is fully above the composer').toBeLessThanOrEqual(g.composerTop);
  // The thumb's end IS the last row's end, give or take the row gap + padding.
  expect(g.scrollerBottom - g.lastRowBottom!, 'nothing but the base padding below the newest row').toBeLessThanOrEqual(24);
  // …and that holds for EVERY row of chrome, not just the input card: the notes
  // bar, the recap tip and the rest ride inside the composer block, so the
  // scrollbar ends above all of them (asked directly, 2026-09-18: "can it also
  // respect the notes and whatever"). A row that moved out of the block would
  // sit inside the scroller's box again and the thumb would run alongside it.
  // The notes bar is the row to require: unlike the recap tip it has no dismiss
  // state, so "the fixture really has chrome above the input card" cannot become
  // a tripwire for an unrelated change to the tip. Whatever else renders is
  // still checked by the loop below.
  expect(g.chrome.map((c) => c.label), 'the fixture renders chrome above the input card')
    .toEqual(expect.arrayContaining(['notes bar', 'input card']));
  for (const row of g.chrome) {
    expect(row.top, `${row.label} (top ${row.top}) is below the scroller's end (${g.scrollerBottom})`)
      .toBeGreaterThanOrEqual(g.scrollerBottom - 1);
  }
  return g;
}

/** End the panel's load window the way a reader does. For ~1s after a load
 *  settles, SessionChatHistory pins the bottom EVERY FRAME (Path A-3) and would
 *  close any gap on its own; a real user types minutes later, when only the
 *  steady-state follow paths are left. That pin stops for good on the first
 *  upward wheel tick, so one tick up and a big one back down puts the panel in
 *  the state the growth scenario is about (checked as a negative control: with
 *  the ResizeObserver pin disabled the scenario stays red only after this). */
async function leaveLoadWindow(page: Page, panel: Locator): Promise<void> {
  const box = (await panel.locator('.session-history').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  await page.mouse.wheel(0, -1);
  await page.waitForTimeout(100);
  await page.mouse.wheel(0, 100_000);
  await expectAtEnd(panel);
}

/** Rows 2 + 3: a taller composer takes height off the scroller, not off the newest row. */
export async function expectTailFollowsComposerGrowth(page: Page, panel: Locator): Promise<void> {
  await leaveLoadWindow(page, panel);
  const before = await geometry(panel);
  const textarea = panel.locator('.session-panel-input textarea');
  await textarea.click();
  if (process.env.FLOW_DEBUG) page.on('console', (m) => { if (/\[scroll/.test(m.text())) console.log(`[browser] ${m.text()}`); });
  // Growth and the check in ONE evaluate so the frame count is meaningful: the
  // ResizeObserver pin runs before paint, so three frames after the draft grows
  // the gap must already be closed, long before the 250ms debounce could.
  const immediate = await panel.evaluate(async (p, draft) => {
    const ta = p.querySelector<HTMLTextAreaElement>('.session-panel-input textarea')!;
    const hist = p.querySelector<HTMLElement>('.session-history')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(ta, draft);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const started = performance.now();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    return {
      elapsedMs: performance.now() - started,
      gap: hist.scrollHeight - hist.scrollTop - hist.clientHeight,
      taHeight: ta.getBoundingClientRect().height,
    };
  }, Array.from({ length: 8 }, (_, i) => `draft line ${i + 1}`).join('\n'));
  const grown = await geometry(panel);
  console.log(`[composer-in-flow] growth immediate=${JSON.stringify(immediate)} before.composerTop=${before.composerTop} grown=${JSON.stringify(grown)}`);
  expect(grown.composerTop, `the composer grew (${before.composerTop} → ${grown.composerTop})`).toBeLessThan(before.composerTop - 40);
  expect(Math.abs(grown.scrollerBottom - grown.composerTop)).toBeLessThanOrEqual(1);
  // Three frames come well before the 250ms debounce on an idle machine, so a
  // closed gap here can only be the pre-paint pin (negative control: with that
  // pin disabled this reads 73px). Under heavy load frames can stretch past the
  // debounce, which can only turn a regression into a pass, never a pass into a
  // failure; the elapsed time is logged so such a run can be recognised.
  expect(immediate.gap, `gap closed within three frames (${Math.round(immediate.elapsedMs)}ms), not after the debounce`).toBeLessThanOrEqual(1);
  await expectAtEnd(panel);
  const g2 = await geometry(panel);
  expect(g2.lastRowBottom!, 'the newest row is still above the taller composer').toBeLessThanOrEqual(g2.composerTop);

  // Shrink back: the scroller regains the height and the end stays the end.
  await textarea.fill('');
  await expect.poll(async () => (await geometry(panel)).composerTop).toBeGreaterThan(grown.composerTop + 40);
  await expectAtEnd(panel);
  await expectScrollerEndsAtComposer(panel);
}

/** Row 4: the way back down is offered above the composer, not under it. */
export async function expectArrowAboveComposer(page: Page, panel: Locator): Promise<void> {
  const hist = panel.locator('.session-history');
  const box = (await hist.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await expect.poll(async () => (await geometry(panel)).arrowVisible, { timeout: 5_000 }).toBe(true);
  const g = await geometry(panel);
  expect(g.arrowBottom!, 'the arrow sits above the composer').toBeLessThanOrEqual(g.composerTop);
  expect(g.composerTop - g.arrowBottom!, 'and close to it, not mid-page').toBeLessThan(60);
  await panel.locator('.scroll-to-bottom-btn').click();
  await expectAtEnd(panel);
}

/** Row 5: the command palette opens upward, above the transcript and the header. */
export async function expectPaletteStacksAboveTranscript(page: Page, panel: Locator): Promise<void> {
  // Part A: the "@" mention palette is the composer's tallest popover (its list
  // runs to min(560px, 60vh)) and opens upward from it; at a SHORT viewport it
  // reaches into the header band (position:absolute, z-index:30), where it must
  // stay on top and keep its clicks.
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.waitForTimeout(300);
  const textarea = panel.locator('.session-panel-input textarea');
  await textarea.click();
  await page.keyboard.type('@');
  const popup = panel.locator('.mention-palette');
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await expect(popup.locator('.mention-list')).not.toBeEmpty({ timeout: 10_000 });
  await page.waitForTimeout(250); // its open animation
  const verdict = await panel.evaluate((p) => {
    const pop = p.querySelector<HTMLElement>('.mention-palette')!;
    // Anchored to the input CARD (the notes bar sits above it inside the wrapper).
    const card = p.querySelector<HTMLElement>('.session-panel-input .chat-input-box')!;
    const header = p.querySelector<HTMLElement>('.session-panel-header')!;
    const b = pop.getBoundingClientRect();
    const hb = header.getBoundingClientRect();
    const probe = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit ? pop.contains(hit) : false;
    };
    return {
      opensUpward: b.bottom <= card.getBoundingClientRect().top + 8,
      reachesHeader: b.top < hb.bottom - 8,
      centreOnTop: probe(b.x + b.width / 2, b.y + b.height / 2),
      headerBandOnTop: probe(b.x + b.width / 2, Math.min(b.top + 6, hb.bottom - 4)),
    };
  });
  expect(verdict.opensUpward, 'popup opens upward from the composer').toBe(true);
  expect(verdict.reachesHeader, 'at this height the popup reaches into the header band (else the test is not testing anything)').toBe(true);
  expect(verdict.centreOnTop, 'popup centre is not covered by the transcript').toBe(true);
  expect(verdict.headerBandOnTop, 'inside the header band the popup is on top of the header').toBe(true);
  await page.keyboard.press('Escape');
  await textarea.fill('');

  // Part B: the composer block ITSELF against the header. The popovers carry
  // their own z-index; the rows above the input card (notes bar, recap tip,
  // send-error line) do not, so they rely on the wrapper being a stacking
  // context above the header (z-index:40, the value it had as an overlay). In a
  // panel too short for its composer the body collapses and those rows slide
  // under the header band; they must still be the ones that paint and get the
  // clicks there (negative control: without the wrapper's z-index the header
  // wins this hit test).
  await page.setViewportSize({ width: 1280, height: 250 });
  await page.waitForTimeout(300);
  await textarea.click();
  await textarea.fill(Array.from({ length: 8 }, (_, i) => `short panel draft line ${i + 1}`).join('\n'));
  await page.waitForTimeout(300);
  const stacking = await panel.evaluate((p) => {
    const input = p.querySelector<HTMLElement>('.session-panel-input')!;
    const header = p.querySelector<HTMLElement>('.session-panel-header')!;
    const notes = p.querySelector<HTMLElement>('.session-notes')!;
    const ib = input.getBoundingClientRect();
    const hb = header.getBoundingClientRect();
    const nb = notes.getBoundingClientRect();
    const y = Math.min(nb.top + nb.height / 2, hb.bottom - 4);
    const hit = document.elementFromPoint(nb.x + nb.width / 2, y);
    return {
      composerTop: ib.top, headerBottom: hb.bottom, notesTop: nb.top,
      overlaps: nb.top < hb.bottom - 8,
      notesOnTop: hit ? notes.contains(hit) : false,
    };
  });
  expect(stacking.overlaps, `the notes bar reaches into the header band (notes ${stacking.notesTop} vs header bottom ${stacking.headerBottom})`).toBe(true);
  expect(stacking.notesOnTop, 'inside the header band the composer block is on top of the header').toBe(true);
  await textarea.fill('');
  await page.setViewportSize({ width: 1280, height: 800 });
}

/** Whole matrix, in order, on one page. */
export async function runComposerInFlowMatrix(page: Page): Promise<void> {
  await mockFlowSession(page);
  const panel = await openFlowSession(page);
  await expectScrollerEndsAtComposer(panel);
  await expectTailFollowsComposerGrowth(page, panel);
  await expectArrowAboveComposer(page, panel);
  await expectPaletteStacksAboveTranscript(page, panel);
}
