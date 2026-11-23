/**
 * A session's chat scrolls behind its glass chrome at both ends (2026-11-23, the user, of a session
 * in the Mac app: "the text should pass behind the glass ... the input box should not cover the
 * text ... when I scroll down it should go under, not a clear dividing line"). The layout is
 * web/src/styles/session-scroll-glass.css, behind the experiment chat_glass_edges (each test here
 * turns it on for its own page, glassOn). composer-in-flow-helpers.ts holds the composer's five
 * scenarios for the default (switch off); this file runs them again with the switch on, with the
 * geometry that changes (the box runs on under the composer, the view ends at its top), and adds
 * what those cannot see:
 *
 *  1. the scrollbar's drawn thumb, read in pixels (a red thumb injected for the check): scrolled to
 *     the end its lower end is the composer's top, scrolled to the start its upper end is the
 *     header's bottom (the 2026-09-18 rule: the thumb never runs on under the chrome);
 *  2. mid-scroll, rows lie under the composer's band and under the header (the text goes behind
 *     the glass), and both bands are see-through glass: alpha under 1 and a backdrop blur in their
 *     computed style. Whether the blur is DRAWN is not checked: Playwright's WebKit (Linux and macOS)
 *     draws no backdrop blur at all, the Mac app's WKWebView does;
 *  3. Tree Mode's path bar on a single page floats under the header: no rule of its own between
 *     them, the page starts at the panel's top, at rest the first row is below the bar, and
 *     mid-scroll rows pass under it.
 *  4. The threads line above the chat (experiment top_thread, a task with Threads on) floats on
 *     glass over the timeline's first rows: data-float is set, at rest the first row starts below
 *     it, and a strip that grows keeps the reader at the end within three frames, as a composer
 *     that grows does (the room the rows are read in shrinks by the strip's height, not the box).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectArrowAboveComposer, expectPaletteStacksAboveTranscript, geometry as flowGeometry, maxGapOverFrames, mockFlowSession, openFlowSession, type Geometry } from './composer-in-flow-helpers';
import { openThreadsSession, expectStackDepth, REWRITTEN_SESSION } from './threads-helpers';
import { discoverBrowserFixture } from './codex-test-audit';

/**
 * The experiment chat_glass_edges on for this page only (its GET /api/config answers with the switch
 * on): the fixture server and every other spec keep the default, off.
 */
export async function glassOn(page: Page, more: Record<string, boolean> = {}): Promise<void> {
  const flags = { chat_glass_edges: true, ...more };
  await page.route(/\/api\/config(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json() as { config?: { experimental?: Record<string, boolean> }; experimental?: Record<string, boolean> };
    if (body.config) body.config.experimental = { ...(body.config.experimental ?? {}), ...flags };
    else body.experimental = { ...(body.experimental ?? {}), ...flags };
    await route.fulfill({ response: res, json: body });
  });
}

/** composer-in-flow's geometry, plus how far the box runs on under the composer and where the view ends. */
type GlassGeometry = Geometry & { overlap: number; viewEnd: number; composerHeight: number };
async function geometry(panel: Locator): Promise<GlassGeometry> {
  const g = await flowGeometry(panel);
  const extra = await panel.evaluate((p) => ({
    overlap: parseFloat(getComputedStyle(p.querySelector<HTMLElement>('.session-history')!).getPropertyValue('--sp-composer-h')) || 0,
    composerHeight: p.querySelector<HTMLElement>('.session-panel-input')!.getBoundingClientRect().height,
  }));
  return { ...g, ...extra, viewEnd: g.scrollerBottom - extra.overlap };
}

/** Where a run keeps its pictures (a check of the look by the developer; nothing asserts on them). */
async function look(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}-${page.context().browser()?.browserType().name()}.png`) });
}

const RED_THUMB = '.session-panel-body .session-history::-webkit-scrollbar-thumb { background: rgb(255, 0, 0) !important; }';

/** A red thumb for the pixel read, styled before the panel mounts: WebKit restyles an existing
 *  scrollbar only at its next layout, so a style added later is not drawn (probed 2026-11-23; a
 *  change of the variables is drawn, see 1c). */
async function redThumb(page: Page): Promise<void> {
  await page.addInitScript((css) => {
    document.addEventListener('DOMContentLoaded', () => {
      const tag = document.createElement('style');
      tag.textContent = css;
      document.head.appendChild(tag);
    });
  }, RED_THUMB);
}

/** The drawn thumb's top and bottom (viewport px) in the scroller's right edge, null when none is drawn. */
export async function thumbSpan(page: Page, panel: Locator): Promise<{ top: number; bottom: number } | null> {
  const box = (await panel.locator('.session-history').boundingBox())!;
  const clip = { x: Math.floor(box.x + box.width - 8), y: Math.floor(box.y), width: 8, height: Math.floor(box.height) };
  const png = await page.screenshot({ clip, scale: 'css', animations: 'disabled' });
  const rows = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const hit: number[] = [];
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (data[i] > 200 && data[i + 1] < 90 && data[i + 2] < 90) { hit.push(y); break; }
      }
    }
    return hit;
  }, png.toString('base64'));
  if (!rows.length) return null;
  return { top: clip.y + rows[0], bottom: clip.y + rows[rows.length - 1] + 1 };
}

/** A pseudo layer's material: its background alpha and whether a backdrop blur is set. */
async function material(el: Locator): Promise<{ alpha: number; blur: boolean }> {
  return el.evaluate((node) => {
    const cs = getComputedStyle(node, '::before');
    const bg = cs.backgroundColor;
    const m = bg.match(/rgba?\(([^)]+)\)/) ?? bg.match(/color\(srgb ([^)]+)\)/);
    let alpha = 1;
    if (bg === 'transparent') alpha = 0;
    else if (m) {
      const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
      alpha = parts.length >= 4 ? Number(parts[3]) : 1;
    }
    const filter = cs.getPropertyValue('backdrop-filter') || cs.getPropertyValue('-webkit-backdrop-filter');
    return { alpha, blur: /blur\(/.test(filter) };
  });
}

async function wheelAt(page: Page, panel: Locator, dy: number): Promise<void> {
  const box = (await panel.locator('.session-history').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(250);
}

/** Rows of the transcript that cross the horizontal line `y` (a row lies under a band there). */
async function rowsCrossing(panel: Locator, y: number): Promise<number> {
  return panel.evaluate((p, at) => {
    const hist = p.querySelector<HTMLElement>('.session-history')!;
    // Only inside the scroller's own box: a row clipped above or below it is not under anything.
    const box = hist.getBoundingClientRect();
    if (at <= box.top || at >= box.bottom) return 0;
    // Every layer at a few points across the line, chrome included: the transcript's own elements
    // among them are the rows lying under the band there.
    let n = 0;
    for (const f of [0.3, 0.5, 0.7]) {
      n += document.elementsFromPoint(box.left + box.width * f, at).filter((el) => el !== hist && hist.contains(el)).length;
    }
    return n;
  }, y);
}

/** Scenarios 1 and 2 on the dense composer fixture. */
export async function runComposerGlassMatrix(page: Page): Promise<void> {
  await glassOn(page);
  await mockFlowSession(page);
  await redThumb(page);
  const panel = await openFlowSession(page);
  await expect(panel).toHaveClass(/is-glass-chat/);
  await page.waitForTimeout(150);

  // 1a. At the end (composer-in-flow's scenario 1 with the switch on): the box runs on under the
  // composer by exactly its height, the view ends at its top, the newest row and every row of the
  // composer's chrome are on their side of that line, and the drawn thumb ends there too.
  expect(await maxGapOverFrames(panel), 'no frame shows a gap under the newest row').toBeLessThanOrEqual(1);
  const end = await geometry(panel);
  expect(end.composerPosition, 'the composer is a flow sibling, not an overlay').not.toBe('absolute');
  expect(Math.abs(end.overlap - end.composerHeight), `overlap ${end.overlap} vs composer height ${end.composerHeight}`).toBeLessThanOrEqual(1);
  expect(Math.abs(end.viewEnd - end.composerTop), `view end ${end.viewEnd} vs composer top ${end.composerTop}`).toBeLessThanOrEqual(1);
  expect(end.lastRowBottom!, 'the newest row is fully above the composer').toBeLessThanOrEqual(end.composerTop);
  expect(end.viewEnd - end.lastRowBottom!, 'nothing but the base padding below the newest row').toBeLessThanOrEqual(24);
  for (const row of end.chrome) expect(row.top, `${row.label} is below the view's end`).toBeGreaterThanOrEqual(end.viewEnd - 1);
  const atEnd = await thumbSpan(page, panel);
  console.log(`[scroll-glass] end geometry=${JSON.stringify({ viewEnd: end.viewEnd, composerTop: end.composerTop, scrollerBottom: end.scrollerBottom })} thumb=${JSON.stringify(atEnd)}`);
  expect(atEnd, 'a thumb is drawn').not.toBeNull();
  expect(Math.abs(atEnd!.bottom - end.composerTop), `thumb bottom ${atEnd!.bottom} vs composer top ${end.composerTop}`).toBeLessThanOrEqual(2);
  expect(end.scrollerBottom - end.composerTop, 'the scroller runs on under the composer').toBeGreaterThan(40);

  // 1c. The composer grows (a long draft): the track follows its new top, in the same session.
  // Scenario 2 with the switch on: the gap the taller composer opens is closed within three frames
  // (the pin watches the room the rows are read in, which the padding takes away).
  const textarea = panel.locator('.session-panel-input textarea');
  await textarea.click();
  const immediate = await panel.evaluate(async (p, draft) => {
    const ta = p.querySelector<HTMLTextAreaElement>('.session-panel-input textarea')!;
    const hist = p.querySelector<HTMLElement>('.session-history')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, draft);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    return hist.scrollHeight - hist.scrollTop - hist.clientHeight;
  }, Array.from({ length: 6 }, (_, i) => `draft line ${i + 1}`).join('\n'));
  expect(immediate, 'the gap under the newest row is closed within three frames').toBeLessThanOrEqual(1);
  await expect.poll(async () => (await geometry(panel)).composerTop).toBeLessThan(end.composerTop - 40);
  await page.waitForTimeout(300);
  const grown = await geometry(panel);
  const grownThumb = await thumbSpan(page, panel);
  console.log(`[scroll-glass] grown composerTop=${grown.composerTop} thumb=${JSON.stringify(grownThumb)}`);
  expect(grownThumb, 'a thumb is drawn with the taller composer').not.toBeNull();
  expect(Math.abs(grownThumb!.bottom - grown.composerTop), `thumb bottom ${grownThumb!.bottom} vs the taller composer's top ${grown.composerTop}`).toBeLessThanOrEqual(2);
  expect(Math.abs(grown.viewEnd - grown.composerTop), 'the view ends at the taller composer').toBeLessThanOrEqual(1);
  expect(grown.lastRowBottom!, 'the newest row is still above the taller composer').toBeLessThanOrEqual(grown.composerTop);
  // Scenario 3: shrink back, still at the end.
  await textarea.fill('');
  await expect.poll(async () => (await geometry(panel)).composerTop).toBeGreaterThan(grown.composerTop + 40);
  await expect.poll(async () => (await geometry(panel)).gap).toBeLessThanOrEqual(1);

  // 2a. The bands are glass: see-through, blurred.
  const composer = panel.locator('.session-panel-input').first();
  const header = panel.locator('.session-panel-header').first();
  const band = await material(composer);
  const head = await material(header);
  console.log(`[scroll-glass] composer band=${JSON.stringify(band)} header=${JSON.stringify(head)}`);
  expect(band.alpha, 'the composer band is see-through').toBeLessThan(1);
  expect(band.blur, 'the composer band blurs what lies under it').toBe(true);
  expect(head.alpha, 'the header is see-through').toBeLessThan(1);
  expect(head.blur, 'the header blurs what lies under it').toBe(true);

  // 2b. Mid-scroll, rows pass under the composer's band and under the header.
  await wheelAt(page, panel, -900);
  const mid = await geometry(panel);
  const headerBottom = (await header.boundingBox())!.y + (await header.boundingBox())!.height;
  await look(page, 'composer-mid');
  expect(await rowsCrossing(panel, mid.composerTop + 12), 'a row lies under the composer band').toBeGreaterThan(0);
  // Under the header too, where the timeline starts at the panel's top (the fixture's session may
  // carry a row above the timeline, which then starts below it: the bar spec covers that case).
  const histTop = (await panel.locator('.session-history').boundingBox())!.y;
  if (histTop < headerBottom - 12) expect(await rowsCrossing(panel, headerBottom - 12), 'a row lies under the header').toBeGreaterThan(0);
  else console.log(`[scroll-glass] the timeline starts at ${histTop}, below the header (${headerBottom}): a row sits above it`);

  // 1b. Toward the start: the track begins at the header's bottom. Older turns load as the reader
  // nears the top, so the box rarely stays at 0; the thumb's place is checked against the track
  // it must run in (its top = track top + scrolled share of the track's free length).
  for (let i = 0; i < 8; i++) {
    await panel.locator('.session-history').evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(400);
    if (await panel.locator('.session-history').evaluate((el) => el.scrollTop) === 0) break;
  }
  const atTop = await thumbSpan(page, panel);
  const track = await panel.evaluate((p) => {
    const hist = p.querySelector<HTMLElement>('.session-history')!;
    const cs = getComputedStyle(hist);
    // How much chrome lies over its top: --sp-cover where a rule sets it (0 under a row in flow), else the header.
    const coverVar = cs.getPropertyValue('--sp-cover').trim();
    const cover = (coverVar ? parseFloat(coverVar) : parseFloat(cs.getPropertyValue('--sp-header-h'))) + (parseFloat(cs.getPropertyValue('--sp-top-h')) || 0);
    const overlap = parseFloat(cs.getPropertyValue('--sp-composer-h')) || 0;
    const top = hist.getBoundingClientRect().top + cover;
    return { top, len: hist.clientHeight - cover - overlap, share: hist.scrollTop / (hist.scrollHeight - hist.clientHeight), scrollTop: hist.scrollTop };
  });
  console.log(`[scroll-glass] top thumb=${JSON.stringify(atTop)} headerBottom=${headerBottom} track=${JSON.stringify(track)}`);
  expect(atTop, 'a thumb is drawn near the start').not.toBeNull();
  const chromeBottom = Math.max(headerBottom, histTop);
  expect(Math.abs(track.top - chromeBottom), 'the track starts where the chrome above the timeline ends').toBeLessThanOrEqual(1);
  const want = track.top + track.share * (track.len - (atTop!.bottom - atTop!.top));
  expect(Math.abs(atTop!.top - want), `thumb top ${atTop!.top} vs ${want} in a track from ${track.top}`).toBeLessThanOrEqual(3);
  expect(atTop!.top, 'the thumb never runs under the chrome').toBeGreaterThanOrEqual(chromeBottom - 1);
  const firstTop = await panel.evaluate((p) => {
    const hist = p.querySelector<HTMLElement>('.session-history')!;
    const row = Array.from(hist.children).find((c) => c.getBoundingClientRect().height > 8 && !c.classList.contains('scroll-to-bottom-btn'));
    return row ? row.getBoundingClientRect().top : null;
  });
  expect(firstTop, 'a first row').not.toBeNull();
  if (track.scrollTop === 0) expect(firstTop!, 'at rest the first row is below the chrome').toBeGreaterThanOrEqual(chromeBottom);

  // Scenarios 4 and 5 with the switch on: the arrow above the composer, the "@" palette above the header.
  await panel.locator('.session-history').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(async () => (await geometry(panel)).gap).toBeLessThanOrEqual(1);
  await expectArrowAboveComposer(page, panel);
  await expectPaletteStacksAboveTranscript(page, panel);
}

/** Scenario 3: Tree Mode's path bar on a single page (the rewritten fixture after a push and a pop). */
export async function runPathBarGlass(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 560 });
  await glassOn(page);
  await redThumb(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const panel = await openThreadsSession(page, REWRITTEN_SESSION, 'pw-task-threads-rewritten', 'Describe the cache expiry rules.');
  const row = panel.locator('.thread-asked-row', { hasText: 'Cache expiry claim' });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expectStackDepth(panel, 1);
  await page.keyboard.press('Escape');
  await expectStackDepth(panel, 0);
  const bar = panel.locator('.tree-path-bar');
  await expect(bar).toBeVisible();
  await expect(panel).toHaveClass(/has-glass-bar/);
  const g = await panel.evaluate((p) => {
    const header = p.querySelector<HTMLElement>('.session-panel-header')!.getBoundingClientRect();
    const barEl = p.querySelector<HTMLElement>('.tree-path-bar')!;
    const b = barEl.getBoundingClientRect();
    const hist = p.querySelector<HTMLElement>('.session-history')!;
    const h = hist.getBoundingClientRect();
    return {
      headerBottom: header.bottom, barTop: b.top, barBottom: b.bottom, histTop: h.top, panelTop: p.getBoundingClientRect().top,
      barPosition: getComputedStyle(barEl).position, headerLine: getComputedStyle(p.querySelector('.session-panel-header')!).borderBottomColor,
      padTop: parseFloat(getComputedStyle(hist).paddingTop), range: hist.scrollHeight - hist.clientHeight,
    };
  });
  console.log(`[scroll-glass] bar ${JSON.stringify(g)}`);
  expect(g.barPosition, 'the bar floats').toBe('absolute');
  expect(Math.abs(g.barTop - g.headerBottom), 'the bar sits right under the header').toBeLessThanOrEqual(1);
  expect(g.headerLine, 'no rule between the header and the bar').toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(Math.abs(g.histTop - g.panelTop), 'the page starts at the panel\'s top, under the glass').toBeLessThanOrEqual(1);
  expect(g.histTop + g.padTop, 'at rest the first row starts below the bar').toBeGreaterThanOrEqual(g.barBottom);
  const glass = await material(bar);
  expect(glass.alpha, 'the bar is see-through').toBeLessThan(1);
  expect(glass.blur, 'the bar blurs').toBe(true);
  // Mid-scroll a row lies under the bar.
  expect(g.range, 'the page scrolls at this height').toBeGreaterThan(80);
  await panel.locator('.session-history').evaluate((el) => { el.scrollTop = Math.min(80, el.scrollHeight - el.clientHeight); });
  await page.waitForTimeout(200);
  await look(page, 'bar-mid');
  expect(await rowsCrossing(panel, g.barBottom - 10), 'a row lies under the bar').toBeGreaterThan(0);
  expect(await rowsCrossing(panel, g.headerBottom - 10), 'and under the header').toBeGreaterThan(0);
  // The thumb starts where the bar ends, never under the header or the bar.
  await panel.locator('.session-history').evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(300);
  const thumb = await thumbSpan(page, panel);
  console.log(`[scroll-glass] bar thumb=${JSON.stringify(thumb)}`);
  expect(thumb, 'a thumb is drawn').not.toBeNull();
  expect(Math.abs(thumb!.top - g.barBottom), `thumb top ${thumb!.top} vs bar bottom ${g.barBottom}`).toBeLessThanOrEqual(2);
}

/** A dense transcript for a real session, so its timeline scrolls (the strip spec's session). */
function denseRows(sid: string, n = 40) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    msgId: `${sid}-m${i}`,
    text: i % 2 === 0
      ? `Question ${i}: does the threads line float over the first rows?`
      : `## Answer ${i}\n\nA paragraph of a real reply, long enough to wrap once in a column.\n\nFinal line of answer ${i}.`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

/**
 * Scenario 4: the threads line above the chat floats on glass. A task with Threads on (one answered
 * thread, so the top shows its card), a real session on the fixture server whose transcript the page
 * reads dense; the experiments chat_glass_edges and top_thread on for this page only.
 */
export async function runFloatingStripGlass(page: Page): Promise<void> {
  const request = page.request;
  const port = Number(process.env.PW_TEST_PORT ?? 3457);
  if (port === 3456) throw new Error('This check writes a task and a thread: run it on a test server, never production');
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const { fixtureRoot } = await discoverBrowserFixture(port);
  const ok = async (res: Awaited<ReturnType<typeof request.post>>) => { expect(res.ok(), await res.text()).toBe(true); return res.json(); };
  const taskId = (await ok(await request.post('/api/tasks', { data: { title: `Glass strip ${stamp}`, project: `Glass ${stamp}`, source: 'local' } }))).task.id as string;
  let sid = '';
  try {
    await ok(await request.patch(`/api/tasks/${taskId}`, { data: { threads_on: true } }));
    await ok(await request.post('/api/sessions/quick-start', { data: { cwd: `${fixtureRoot}/projects/walnut`, message: `Glass ready ${stamp}`, taskId } }));
    await expect.poll(async () => (sid = (await (await request.get(`/api/tasks/${taskId}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('');
    const { thread } = await ok(await request.post(`/api/v1/tasks/${taskId}/threads`, { data: { text: `Seed order ${stamp}, how does it stand?` } }));
    await ok(await request.patch(`/api/v1/tasks/${taskId}/threads/${thread.id}`, { data: { title: `Seed order ${stamp}`, reply: 'Seed order: done, the notes are in.', state: 'answered' } }));

    const messages = denseRows(sid);
    await page.route(`**/api/sessions/${sid}/history**`, (route) => route.fulfill({
      json: { messages, total: messages.length, ...(route.request().url().includes('source=streams') ? {} : { cursor: messages.length }), delta: false },
    }));
    await glassOn(page, { top_thread: true });
    await page.addInitScript((id) => {
      sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]));
    }, sid);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toHaveClass(/is-glass-chat/);
    const strip = panel.getByTestId('session-top');
    await expect(strip).toBeVisible({ timeout: 30_000 });
    await expect(strip, 'alone above the timeline, the strip floats').toHaveAttribute('data-float', '');
    await expect(panel.locator('.session-history')).toContainText(`Final line of answer ${messages.length - 1}`, { timeout: 20_000 });
    await expect.poll(() => maxGapOverFrames(panel, 10), { timeout: 10_000 }).toBeLessThanOrEqual(1);

    // At rest the first row starts below the strip: the timeline pads its top by the strip's height.
    const rest = await panel.evaluate((p) => {
      const hist = p.querySelector<HTMLElement>('.session-history')!;
      const s = p.querySelector<HTMLElement>('[data-testid="session-top"]')!.getBoundingClientRect();
      return { stripBottom: s.bottom, histTop: hist.getBoundingClientRect().top, padTop: parseFloat(getComputedStyle(hist).paddingTop) };
    });
    console.log(`[scroll-glass] strip ${JSON.stringify(rest)}`);
    expect(rest.histTop, 'the timeline runs on under the strip').toBeLessThan(rest.stripBottom);
    expect(rest.histTop + rest.padTop, 'at rest the first row starts below the strip').toBeGreaterThanOrEqual(rest.stripBottom);
    const material0 = await material(strip);
    expect(material0.alpha, 'the strip is see-through').toBeLessThan(1);
    expect(material0.blur, 'the strip blurs').toBe(true);

    // The strip grows by 60px while the reader is at the end: the end stays the end, before the
    // debounce (three frames, as for the composer). First out of the load window, whose per-frame
    // pin would close any gap and hide a missing one (composer-in-flow's leaveLoadWindow): a wheel
    // of the reader's own, back to the end.
    await wheelAt(page, panel, -1);
    await page.mouse.wheel(0, 100_000);
    await expect.poll(() => maxGapOverFrames(panel, 10), { timeout: 10_000 }).toBeLessThanOrEqual(1);
    const grown = await panel.evaluate(async (p) => {
      const hist = p.querySelector<HTMLElement>('.session-history')!;
      const top = p.querySelector<HTMLElement>('[data-testid="session-top"]')!;
      const before = top.offsetHeight;
      top.style.minHeight = `${before + 60}px`;
      const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      const gaps: number[] = [];
      for (let i = 0; i < 3; i++) { await frame(); gaps.push(hist.scrollHeight - hist.scrollTop - hist.clientHeight); }
      return { before, after: top.offsetHeight, gaps, padTop: parseFloat(getComputedStyle(hist).paddingTop) };
    });
    console.log(`[scroll-glass] strip grew ${JSON.stringify(grown)}`);
    expect(grown.after, 'the strip grew').toBeGreaterThanOrEqual(grown.before + 59);
    expect(grown.gaps[2]!, `the reader stays at the end as the strip grows (gaps per frame ${grown.gaps.join(', ')})`).toBeLessThanOrEqual(1);
    await look(page, 'strip-grown');
  } finally {
    if (sid) await request.post(`/api/v1/sessions/${sid}/terminate`, { data: { force: true } });
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${taskId}?force=true`);
      if (res.ok() || res.status() === 404) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
