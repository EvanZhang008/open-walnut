/**
 * A full-screen session's side edges drag it wider or narrower, and the chat's margin inside
 * stays the same (the user, 2026-11-23, by voice: in full screen "I want this page at its side
 * to be draggable ... default OK that width, but I can drag it a bit wider. But this margin
 * stays the same"). components/sessions/SheetWidthEdges.tsx.
 *
 * Scenarios: the default width is the sheet's own; a drag on the right edge widens both sides
 * (the sheet stays centred) and the chat's gutter is unchanged; a drag on the left edge
 * narrows it, never under the minimum; the width is kept after leaving and entering full
 * screen; a double-click puts back the default; past the window it stops short of the edge.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { MOCK_SESSION_ID as SID, mockSession, open } from './mock-session-harness';

const SHOTS = process.env.SHEET_WIDTH_SHOTS ?? '/tmp/sheet-width';
const at = (n: number) => new Date(Date.UTC(2026, 10, 23, 1, 0, n)).toISOString();
const HISTORY = [
  { role: 'user', text: 'SW_ASK how wide can this get?', timestamp: at(0) },
  { role: 'assistant', text: `SW_REPLY ${'Every line of this reply runs the width of the chat so its margin is easy to measure. '.repeat(6)}`, msgId: 'sw-a1', timestamp: at(30) },
];

async function geometry(panel: Locator) {
  return panel.evaluate((p) => {
    const box = p.getBoundingClientRect();
    const hist = p.querySelector('.session-history') as HTMLElement;
    const body = hist.querySelector('.session-msg-assistant .markdown-body') as HTMLElement;
    const b = body.getBoundingClientRect();
    return { left: box.left, right: box.right, width: box.width, gutterLeft: b.left - box.left, gutterRight: box.right - b.right, view: window.innerWidth };
  });
}

async function dragEdge(page: Page, edge: Locator, dx: number) {
  const b = (await edge.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

test('a full-screen session drags wider and narrower from its side edges, keeping its margin', async ({ page }) => {
  await mockSession(page, HISTORY, 'idle');
  const hist = await open(page);
  await page.setViewportSize({ width: 1512, height: 920 });
  await expect(hist).toContainText('SW_REPLY', { timeout: 60_000 });
  const panel = page.locator(`.session-panel[data-session-id="${SID}"]`);
  await panel.getByRole('button', { name: 'Expand session to full screen' }).click();
  await expect(panel).toHaveClass(/open-walnut-fullscreen/);
  await page.waitForTimeout(300);

  const base = await geometry(panel);
  const right = panel.getByTestId('sheet-width-edge-right');
  const left = panel.getByTestId('sheet-width-edge-left');
  await expect(right).toBeVisible();
  expect(await right.evaluate((e) => getComputedStyle(e).cursor)).toBe('ew-resize');

  // Wider from the right edge: both sides move, the sheet stays centred, the gutter holds.
  await dragEdge(page, right, 25);
  const wide = await geometry(panel);
  expect(wide.width - base.width, 'the sheet widened by both sides').toBeGreaterThan(40);
  expect(Math.abs((wide.left - base.left) + (wide.right - base.right)), 'both sides moved alike: the sheet stays centred').toBeLessThanOrEqual(2);
  expect(Math.abs(wide.gutterLeft - base.gutterLeft), "the chat's left margin stays the same").toBeLessThanOrEqual(1);
  expect(Math.abs(wide.gutterRight - base.gutterRight), "the chat's right margin stays the same").toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}/wide.png` }).catch(() => {});

  // Past the window: it stops short of the edge.
  await dragEdge(page, right, 400);
  const max = await geometry(panel);
  expect(max.left, 'room is left at the window edge').toBeGreaterThanOrEqual(11);
  expect(max.view - max.right).toBeGreaterThanOrEqual(11);

  // Narrower from the left edge, never under the minimum.
  await dragEdge(page, left, 700);
  const narrow = await geometry(panel);
  expect(narrow.width, 'the sheet keeps its minimum width').toBeGreaterThanOrEqual(639);
  expect(narrow.width).toBeLessThan(base.width);
  expect(Math.abs(narrow.gutterLeft - base.gutterLeft), "the chat's margin stays the same when narrow").toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}/narrow.png` }).catch(() => {});

  // Kept: out of full screen and back, the same width.
  await panel.getByRole('button', { name: 'Collapse session' }).click();
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen/);
  await panel.getByRole('button', { name: 'Expand session to full screen' }).click();
  await expect(panel).toHaveClass(/open-walnut-fullscreen/);
  await page.waitForTimeout(300);
  expect(Math.abs((await geometry(panel)).width - narrow.width), 'the width is kept for the next full screen').toBeLessThanOrEqual(1);

  // A double-click puts back the default.
  await left.dblclick();
  await page.waitForTimeout(150);
  expect(Math.abs((await geometry(panel)).width - base.width), 'a double-click puts back the default width').toBeLessThanOrEqual(1);
});

test('the edges stay off the scrollbar, Escape cancels a drag only, a still press keeps nothing, keys step it, the review column adds on top', async ({ page }) => {
  await mockSession(page, HISTORY, 'idle');
  const hist = await open(page);
  await page.setViewportSize({ width: 1512, height: 920 });
  await expect(hist).toContainText('SW_REPLY', { timeout: 60_000 });
  await page.evaluate(() => localStorage.removeItem('walnut:session-sheet-width'));
  const panel = page.locator(`.session-panel[data-session-id="${SID}"]`);
  await panel.getByRole('button', { name: 'Expand session to full screen' }).click();
  await expect(panel).toHaveClass(/open-walnut-fullscreen/);
  await page.waitForTimeout(300);
  const base = await geometry(panel);
  const right = panel.getByTestId('sheet-width-edge-right');
  const left = panel.getByTestId('sheet-width-edge-left');
  const kept = () => page.evaluate(() => localStorage.getItem('walnut:session-sheet-width'));

  // Both edges sit outside the sheet, so the chat's scrollbar inside its right edge stays the history's.
  const r = (await right.boundingBox())!, l = (await left.boundingBox())!;
  expect(r.x, 'the right edge starts at the sheet\'s right side').toBeGreaterThanOrEqual(base.right - 1);
  expect(l.x + l.width, 'the left edge ends at the sheet\'s left side').toBeLessThanOrEqual(base.left + 1);
  const atScrollbar = await panel.evaluate((p) => {
    const h = p.querySelector('.session-history') as HTMLElement;
    const b = h.getBoundingClientRect();
    return document.elementFromPoint(b.right - 3, b.top + b.height / 2)?.closest('.session-history') === h;
  });
  expect(atScrollbar, 'a point on the scrollbar hits the history, not an edge').toBe(true);

  // Escape mid-drag: the width before the drag, still full screen, nothing kept.
  const rb = (await right.boundingBox())!;
  await page.mouse.move(rb.x + 4, rb.y + 300);
  await page.mouse.down();
  await page.mouse.move(rb.x + 80, rb.y + 300, { steps: 4 });
  // Moves land on the next frame (the drag hook coalesces them).
  await expect.poll(async () => (await geometry(panel)).width).toBeGreaterThan(base.width + 40);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(150);
  await expect(panel, 'Escape ends the drag, not full screen').toHaveClass(/open-walnut-fullscreen/);
  expect(Math.abs((await geometry(panel)).width - base.width), 'Escape puts back the width before the drag').toBeLessThanOrEqual(1);
  expect(await kept()).toBeNull();

  // A press that never moves keeps nothing.
  await page.mouse.move(rb.x + 4, rb.y + 300);
  await page.mouse.down();
  await page.mouse.up();
  expect(await kept(), 'a still press keeps no width').toBeNull();

  // Keys on a focused edge: the outward arrow widens, the inward one narrows, Home is the default.
  await right.focus();
  await page.keyboard.press('ArrowRight');
  const stepped = await geometry(panel);
  expect(stepped.width - base.width).toBeGreaterThan(40);
  expect(Math.abs(stepped.gutterRight - base.gutterRight), 'the margin holds when a key steps it').toBeLessThanOrEqual(1);
  await expect(right).toHaveAttribute('aria-valuenow', String(Math.round(stepped.width)));
  await left.focus();
  await page.keyboard.press('ArrowRight');
  expect(Math.abs((await geometry(panel)).width - base.width), 'the left edge\'s inward arrow narrows it back').toBeLessThanOrEqual(2);
  await page.keyboard.press('Home');
  expect(await kept(), 'Home forgets the width').toBeNull();

  // With the review column open the sheet grows outward by it; a drag inward still narrows it.
  await dragEdge(page, left, -60);
  const dragged = await geometry(panel);
  await panel.locator('.session-history').evaluate((h) => h.setAttribute('data-review-sidebar', 'open'));
  await page.waitForTimeout(150);
  const withReview = await geometry(panel);
  expect(withReview.width, 'the review column adds its room on top of the dragged width').toBeGreaterThan(dragged.width + 100);
  await dragEdge(page, right, -20);
  const inward = await geometry(panel);
  expect(inward.width, 'a drag inward narrows the sheet with the review column open').toBeLessThan(withReview.width);
  expect(withReview.width - inward.width).toBeLessThanOrEqual(60);
});

test('a drag made while the review column is open keeps the chat margin of the default width once it closes', async ({ page }) => {
  await mockSession(page, HISTORY, 'idle');
  const hist = await open(page);
  // 1200: the default margin here is under 40px (4% of the sheet), so a margin taken from the
  // sheet the review column widened would show.
  await page.setViewportSize({ width: 1200, height: 860 });
  await expect(hist).toContainText('SW_REPLY', { timeout: 60_000 });
  await page.evaluate(() => localStorage.removeItem('walnut:session-sheet-width'));
  const panel = page.locator(`.session-panel[data-session-id="${SID}"]`);
  await panel.getByRole('button', { name: 'Expand session to full screen' }).click();
  await expect(panel).toHaveClass(/open-walnut-fullscreen/);
  await page.waitForTimeout(300);
  const base = await geometry(panel);
  const history = panel.locator('.session-history');
  await history.evaluate((h) => h.setAttribute('data-review-sidebar', 'open'));
  await page.waitForTimeout(150);
  // At this window the review column already takes the sheet to the window's gutter: a drag in.
  await dragEdge(page, panel.getByTestId('sheet-width-edge-right'), -60);
  await history.evaluate((h) => h.removeAttribute('data-review-sidebar'));
  await page.waitForTimeout(150);
  const after = await geometry(panel);
  expect(after.width, 'the drag narrowed the sheet').toBeLessThan(base.width - 40);
  expect(Math.abs(after.gutterLeft - base.gutterLeft), "the chat's left margin is the default one").toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.gutterRight - base.gutterRight), "the chat's right margin is the default one, not the review column's room").toBeLessThanOrEqual(0.5);
  const edge = panel.getByTestId('sheet-width-edge-right');
  await expect(edge).toHaveAttribute('aria-valuenow', String(Math.round(after.width)));
  expect(Number(await edge.getAttribute('aria-valuemax')), 'the range tops out short of the window').toBeLessThanOrEqual(1200 - 56 - 24);
});

test('a window too small for the review column and the minimum keeps nothing a drag cannot show', async ({ page }) => {
  await mockSession(page, HISTORY, 'idle');
  const hist = await open(page);
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(hist).toContainText('SW_REPLY', { timeout: 60_000 });
  await page.evaluate(() => localStorage.removeItem('walnut:session-sheet-width'));
  const panel = page.locator(`.session-panel[data-session-id="${SID}"]`);
  await panel.getByRole('button', { name: 'Expand session to full screen' }).click();
  await expect(panel).toHaveClass(/open-walnut-fullscreen/);
  await panel.locator('.session-history').evaluate((h) => h.setAttribute('data-review-sidebar', 'open'));
  await page.waitForTimeout(200);
  const edge = panel.getByTestId('sheet-width-edge-right');
  const [now, min, max] = await Promise.all(['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map(async (a) => Number(await edge.getAttribute(a))));
  expect(min, 'the range is one the window can show').toBeLessThanOrEqual(max);
  expect(now).toBeGreaterThanOrEqual(min);
  expect(now).toBeLessThanOrEqual(max);
  // Outward there is no room: the sheet stays as it is and nothing is kept.
  await dragEdge(page, edge, 200);
  expect(await page.evaluate(() => localStorage.getItem('walnut:session-sheet-width')), 'a drag the sheet could not show keeps nothing').toBeNull();
  await dragEdge(page, edge, -30);
  const kept = await page.evaluate(() => localStorage.getItem('walnut:session-sheet-width'));
  if (kept !== null) expect(Number(kept), 'a kept width is one the sheet showed').toBeLessThanOrEqual(max);
});
