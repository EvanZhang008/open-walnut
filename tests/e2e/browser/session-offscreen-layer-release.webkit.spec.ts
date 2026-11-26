/**
 * WebKit's stale layer surfaces of rows that scrolled away (release-offscreen-layers.ts).
 *
 * In WebKit only, 1.5 s after a reply stops streaming while the reader is at the live end, the
 * rows well above the view are marked `data-layer-release` for two frames: their content is out
 * of the layout while they keep their height, then everything is put back. Playwright cannot see
 * layer surfaces, so this spec checks the behavior a reader could notice: the rows marked, when
 * and for how long, that nothing on screen moves, the scroll stays at the bottom, and the rows
 * holding the reader's selection or focus are left alone. An in-page MutationObserver records
 * every mark and unmark with its time and frame; a setAttribute wrapper measures the geometry
 * just before the first mark of a pass.
 *
 * Harness: mock-session-harness.ts (captured WebSocket, mocked history; no daemon, no CLI).
 * Run: PW_WEBKIT=1 bun x playwright test session-offscreen-layer-release.webkit --project webkit
 * In Chromium the hook does nothing: the first test checks that no row is ever marked there.
 * The release runs on a Mac desktop's WebKit only (isMacDesktopWebKit), so the WebKit run, on
 * Linux, presents a Mac Safari user agent.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { MOCK_SESSION_ID as SESSION_ID, injectEvent, mockSession, open, waitForWs } from './mock-session-harness';

const VIEWPORT = { width: 1200, height: 800 };

/** A reply as tall and wide as the ones that left surfaces behind: a fenced block of lines wider
 *  than the column and a wide table. `END_<n>` closes it, so a spec can wait for all of it. */
function longReply(n: number): string {
  const line = (i: number) => `const row_${n}_${i} = compute(${Array.from({ length: 10 }, (_, k) => `"value-${n}-${i}-${k}"`).join(', ')}); // a line wider than the column`;
  const code = Array.from({ length: 28 }, (_, i) => line(i)).join('\n');
  const cols = Array.from({ length: 10 }, (_, k) => `Column ${k} heading`);
  const rows = Array.from({ length: 10 }, (_, r) => `| ${cols.map((_, k) => `cell ${n}.${r}.${k} with some text`).join(' | ')} |`).join('\n');
  return `Reply ${n}: the analysis of part ${n}, with the code and the table below.\n\n\`\`\`ts\n${code}\n\`\`\`\n\n| ${cols.join(' | ')} |\n|${' --- |'.repeat(cols.length)}\n${rows}\n\nThat is all for part ${n}. END_${n}`;
}

const at = (i: number) => new Date(1700000000000 + i * 60_000).toISOString();
/** Ten earlier turns, so the column has rows far above the view from the start. */
function baseHistory(): unknown[] {
  const rows: unknown[] = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ role: 'user', text: `Earlier question ${i}: look at part ${i} please.`, msgId: `base-u-${i}`, timestamp: at(i * 2) });
    rows.push({ role: 'assistant', text: longReply(100 + i), msgId: `base-a-${i}`, timestamp: at(i * 2 + 1) });
  }
  return rows;
}

interface Release {
  at: number; frame: number;
  marked: number;
  /** The smallest distance of a marked row's bottom above the view's top (must exceed 200). */
  minAbove: number;
  /** The reader's state: distance from the bottom and scrollHeight, before, during, after. */
  fbBefore: number; shBefore: number; shDuring: number; fbAfter?: number; fbNextFrame?: number;
  /** How far the rows on screen moved, at most (px), during the release frame and after it. */
  moveDuring: number; moveAfter?: number; moveNextFrame?: number;
  removedAt?: number; removedFrame?: number; removedCount: number;
}
interface Watch {
  events: { kind: 'add' | 'remove'; t: number; frame: number }[];
  releases: Release[];
  frames: number;
  /** Rows marked that hold the reader's selection or focus (must stay 0). */
  guardHits: string[];
  holdSecond: boolean; heldCount: number; heldCancelled: number;
  /** The hook's 1.5 s waits: when each started, fired or was cleared, and the reader's distance
   *  from the bottom when it fired. */
  timers: { at: number; firedAt?: number; clearedAt?: number; fbAtFire?: number }[];
}

/** In the page, before the app: watch every mark and unmark of `data-layer-release`. */
function installReleaseWatch() {
  const ATTR = 'data-layer-release';
  const w = window as any;
  const watch = { events: [], releases: [], frames: 0, guardHits: [], holdSecond: false, heldCount: 0, heldCancelled: 0, timers: [] } as any;
  w.__relWatch = watch;
  const marked = new Set<Element>();
  w.__relMarked = marked;
  w.__relGuard = {} as Record<string, Element | undefined>;
  const origRaf = window.requestAnimationFrame.bind(window);
  const origCancel = window.cancelAnimationFrame.bind(window);
  const tick = () => { watch.frames++; origRaf(tick); };
  origRaf(tick);

  const geom = (box: HTMLElement) => {
    const view = box.getBoundingClientRect();
    const onScreen: [Element, number][] = [];
    for (const el of Array.from(box.children)) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > view.top && r.top < view.bottom) onScreen.push([el, r.top]);
    }
    return { fb: box.scrollHeight - box.scrollTop - box.clientHeight, sh: box.scrollHeight, onScreen };
  };
  const moved = (before: [Element, number][]) =>
    before.reduce((m, [el, top]) => Math.max(m, Math.abs(el.getBoundingClientRect().top - top)), 0);

  // The first mark of a pass: measure first, and tell the frame wrapper that the hook's
  // requestAnimationFrame call in this same task is the release's first frame.
  let marking = false;
  let pending: { box: HTMLElement; before: ReturnType<typeof geom>; at: number; frame: number } | null = null;
  let current: (Release & { before: [Element, number][]; box: HTMLElement }) | null = null;
  const origSet = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (name === ATTR && !marking && this.parentElement) {
      marking = true;
      queueMicrotask(() => { marking = false; });
      pending = { box: this.parentElement, before: geom(this.parentElement), at: performance.now(), frame: watch.frames };
    }
    return origSet.call(this, name, value);
  };

  // Optional: hold the release's SECOND frame (requested inside its first), so a spec can act
  // between the two frames. cancelAnimationFrame of a held frame drops it.
  let inFirst = false;
  const held = new Map<number, FrameRequestCallback>();
  let fakeId = 1_000_000_000;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    if (watch.holdSecond && marking) return origRaf((t) => { inFirst = true; try { cb(t); } finally { inFirst = false; } });
    if (watch.holdSecond && inFirst) { const id = ++fakeId; held.set(id, cb); watch.heldCount = held.size; return id; }
    return origRaf(cb);
  };
  window.cancelAnimationFrame = (id: number) => {
    if (held.delete(id)) { watch.heldCancelled++; watch.heldCount = held.size; return; }
    origCancel(id);
  };
  // The hook's own 1.5 s wait, told apart from other timers of that length by its module in
  // the stack (the fixture serves the source modules).
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  const ours = new Map<number, any>();
  (window as any).setTimeout = (fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms !== 1500 || typeof fn !== 'function' || !/release-offscreen-layers/.test(new Error().stack ?? '')) return origSetTimeout(fn, ms, ...args);
    const rec: any = { at: performance.now() };
    watch.timers.push(rec);
    // `__relHoldWait`: the test holds the wait's end until it has set up what the pass must meet
    // (a loaded host can take longer than the wait to make a selection).
    const fire = () => {
      if (rec.clearedAt !== undefined) return;
      if (w.__relHoldWait) { origSetTimeout(fire, 50); return; }
      rec.firedAt = performance.now();
      const box = document.querySelector('.session-history');
      if (box) rec.fbAtFire = box.scrollHeight - box.scrollTop - box.clientHeight;
      (fn as (...a: unknown[]) => void)(...args);
    };
    const id = origSetTimeout(fire, ms);
    ours.set(id, rec);
    return id;
  };
  (window as any).clearTimeout = (id?: number) => {
    const rec = id === undefined ? undefined : ours.get(id);
    if (rec && rec.firedAt === undefined && rec.clearedAt === undefined) rec.clearedAt = performance.now();
    origClearTimeout(id);
  };
  w.__relReleaseHeld = () => { for (const [id, cb] of [...held]) { held.delete(id); cb(performance.now()); } watch.heldCount = 0; };

  // Observed on the document itself: an init script runs before <html> exists in WebKit.
  new MutationObserver((records) => {
    const t = performance.now();
    const adds: Element[] = [];
    let removes = 0;
    for (const r of records) {
      const el = r.target as Element;
      if (el.hasAttribute(ATTR) && r.oldValue === null) adds.push(el);
      else if (!el.hasAttribute(ATTR) && r.oldValue !== null) removes++;
    }
    for (const el of adds) {
      watch.events.push({ kind: 'add', t, frame: watch.frames });
      marked.add(el);
      for (const [k, g] of Object.entries(w.__relGuard as Record<string, Element | undefined>)) if (g && g === el) watch.guardHits.push(`${k}@${Math.round(t)}`);
    }
    for (let i = 0; i < removes; i++) watch.events.push({ kind: 'remove', t, frame: watch.frames });
    if (adds.length > 0 && pending) {
      const { box, before } = pending;
      const view = box.getBoundingClientRect();
      const during = geom(box);
      current = {
        at: pending.at, frame: pending.frame, marked: adds.length,
        minAbove: Math.min(...adds.map((el) => view.top - el.getBoundingClientRect().bottom)),
        fbBefore: before.fb, shBefore: before.sh, shDuring: during.sh,
        moveDuring: moved(before.onScreen), removedCount: 0, before: before.onScreen, box,
      };
      pending = null;
      watch.releases.push(current);
    }
    if (removes > 0 && current) {
      const rel = current;
      rel.removedCount += removes;
      if (rel.removedAt === undefined) {
        rel.removedAt = t; rel.removedFrame = watch.frames;
        rel.fbAfter = geom(rel.box).fb; rel.moveAfter = moved(rel.before);
        origRaf(() => { rel.fbNextFrame = geom(rel.box).fb; rel.moveNextFrame = moved(rel.before); });
      }
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: [ATTR], attributeOldValue: true });
}

const readWatch = (page: Page) => page.evaluate(() => {
  const w = (window as any).__relWatch;
  return {
    events: w.events, frames: w.frames, guardHits: w.guardHits, heldCount: w.heldCount, heldCancelled: w.heldCancelled, timers: w.timers,
    // Drop the element references: plain numbers only.
    releases: w.releases.map(({ before: _b, box: _x, ...rest }: any) => rest),
  } as Watch;
});

/** Rows still marked anywhere: in the page, or detached rows the hook marked. */
const stillMarked = (page: Page) => page.evaluate(() => {
  const marked = [...((window as any).__relMarked as Set<HTMLElement>)];
  return {
    inPage: document.querySelectorAll('[data-layer-release]').length,
    everMarked: marked.length,
    leftMarked: marked.filter((el) => el.hasAttribute('data-layer-release') || el.style.getPropertyValue('--layer-release-h') !== '').length,
  };
});

/** The distance from the live end; while the column is still being drawn (no box yet, or two for
 *  a frame), a number that keeps a poll waiting, and the reason, in `lastFromBottomMiss`. */
let lastFromBottomMiss = '';
const fromBottom = (hist: Locator) => hist.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  .then((d) => (typeof d === 'number' && Number.isFinite(d) ? d : (lastFromBottomMiss = `value ${String(d)}`, Number.MAX_SAFE_INTEGER)))
  .catch((err: unknown) => { lastFromBottomMiss = String(err).slice(0, 300); return Number.MAX_SAFE_INTEGER; });

interface Session { page: Page; hist: Locator; history: unknown[]; errors: string[] }

async function openSession(page: Page): Promise<Session> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // The mock serves the session's record and history only; its other reads (cost, supervision,
  // slash commands, the task) answer 404, which the app logs as an error. Every other error counts.
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() !== 'error') return;
    if (/^Failed to load resource: .*404/.test(text) || /^\[api\] GET \S+ → 404 /.test(text)) return;
    errors.push(`console: ${text}`);
  });
  await page.addInitScript(installReleaseWatch);
  const history = baseHistory();
  await mockSession(page, history, 'running');
  const hist = await open(page);
  await page.setViewportSize(VIEWPORT);
  await waitForWs(page).catch(async (err) => {
    const state = await page.evaluate(() => ({ url: location.href, watch: !!(window as any).__relWatch, ws: !!(window as any).__capturedWs, body: document.body.innerText.slice(0, 300) })).catch((e) => String(e));
    throw new Error(`${err}\npage: ${JSON.stringify(state)}\nerrors: ${JSON.stringify(errors)}`);
  });
  await expect(hist).toContainText('END_109', { timeout: 30_000 });
  // At the live end once the opening scroll is done.
  await expect.poll(() => fromBottom(hist), { timeout: 20_000, message: `at the live end after opening (${lastFromBottomMiss})` }).toBeLessThanOrEqual(2);
  return { page, hist, history, errors };
}

/** One turn: the prompt reaches history, the reply streams in, then the turn ends and history
 *  absorbs the reply (the persisted row replaces its stream block). Returns the end's time. */
async function streamAndSettle(s: Session, n: number, opts: { beforeEnd?: () => Promise<void>; afterAbsorb?: () => Promise<void>; absorb?: boolean } = {}): Promise<number> {
  const { page, hist, history } = s;
  history.push({ role: 'user', text: `Question ${n}: now look at part ${n}.`, msgId: `u-${n}`, timestamp: at(100 + n * 2) });
  const text = longReply(n);
  const msgId = `reply-${n}`;
  const step = Math.ceil(text.length / 10);
  for (let i = 0; i < text.length; i += step) {
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: text.slice(i, i + step), msgId });
    await page.waitForTimeout(60);
  }
  await expect(hist).toContainText(`END_${n}`, { timeout: 15_000 });
  await opts.beforeEnd?.();
  history.push({ role: 'assistant', text, msgId, timestamp: at(100 + n * 2 + 1) });
  // The end's time is taken in the page as the result event is dispatched.
  const endedAt = await page.evaluate((sid) => {
    const at = performance.now();
    const frame = JSON.stringify({ type: 'event', name: 'session:result', data: { sessionId: sid, result: 'done', isError: false }, seq: Date.now() });
    ((window as any).__capturedWs as WebSocket).dispatchEvent(new MessageEvent('message', { data: frame }));
    return at;
  }, SESSION_ID);
  await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 });
  if (opts.absorb === false) return endedAt;
  // Absorbed: the reply is a persisted row now.
  await expect.poll(() => hist.evaluate((el, end) =>
    [...el.querySelectorAll('[data-msg-index]')].some((r) => (r.textContent ?? '').includes(end)), `END_${n}`), { timeout: 15_000 }).toBe(true);
  await opts.afterAbsorb?.();
  return endedAt;
}

/** The pass that ran after `endedAt`, once it is put back (or null when none ran in `ms`). */
// Long enough for the 1.5 s wait and the two frames after it on a loaded host, where another
// worker's page shares the machine and a timer can fire seconds late.
async function releaseAfter(page: Page, endedAt: number, ms = 10_000): Promise<Release | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const w = await readWatch(page);
    const rel = w.releases.find((r) => r.at > endedAt);
    if (rel && rel.removedAt !== undefined && rel.fbNextFrame !== undefined) return rel;
    if (Date.now() > deadline) return rel ?? null;
    await page.waitForTimeout(100);
  }
}

const MAC_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
test.use({ userAgent: process.env.PW_WEBKIT ? MAC_SAFARI_UA : undefined });

test.describe('WebKit drops the layers of rows that left the view', () => {
  // Up to seven long replies stream and settle per test, each with a 1.5 s wait.
  test.describe.configure({ timeout: 150_000 });

  test('each settled reply releases the rows far above, and nothing on screen moves', async ({ page, browserName }) => {
    const s = await openSession(page);
    const REPLIES = 5;
    for (let n = 1; n <= REPLIES; n++) {
      const endedAt = await streamAndSettle(s, n);
      if (browserName !== 'webkit') continue;
      const rel = await releaseAfter(page, endedAt);
      const msg = `reply ${n}: ${JSON.stringify(rel)}`;
      expect(rel, `reply ${n}: no row was released`).not.toBeNull();
      // The hook's wait starts once the end is rendered, and the rows are marked 1.5 s later.
      // The end to the mark: within 2.5 s on an idle machine; the render of the end on a loaded
      // host adds to it, so that sum is only bounded loosely and logged.
      const timer = (await readWatch(page)).timers.find((t) => t.at > endedAt);
      expect(timer, `reply ${n}: the hook's 1.5 s wait started`).toBeTruthy();
      const wait = rel!.at - timer!.at;
      expect(wait, msg).toBeGreaterThanOrEqual(1490);
      // Never early; late only by what a loaded host does to a timer (seen up to 3 s on clouddev).
      expect(wait, msg).toBeLessThanOrEqual(5000);
      expect(rel!.at - endedAt, msg).toBeLessThanOrEqual(5000);
      console.log(`[layer-release] reply ${n}: end to wait start ${Math.round(timer!.at - endedAt)} ms, wait ${Math.round(wait)} ms, end to mark ${Math.round(rel!.at - endedAt)} ms`);
      expect(rel!.marked, msg).toBeGreaterThan(0);
      expect(rel!.minAbove, msg).toBeGreaterThan(200);
      // Every mark put back, within a few frames.
      expect(rel!.removedCount, msg).toBe(rel!.marked);
      expect(rel!.removedFrame! - rel!.frame, msg).toBeLessThanOrEqual(4);
      // At the bottom before and after; no collapse; the rows on screen stay where they are.
      expect(rel!.fbBefore, msg).toBeLessThanOrEqual(2);
      expect(rel!.fbAfter!, msg).toBeLessThanOrEqual(2);
      expect(rel!.fbNextFrame!, msg).toBeLessThanOrEqual(2);
      expect(Math.abs(rel!.shDuring - rel!.shBefore), msg).toBeLessThanOrEqual(1);
      expect(rel!.moveDuring, msg).toBeLessThanOrEqual(1);
      expect(rel!.moveAfter!, msg).toBeLessThanOrEqual(1);
      expect(rel!.moveNextFrame!, msg).toBeLessThanOrEqual(1);
      expect((await stillMarked(page)).inPage, msg).toBe(0);
      console.log(`[layer-release] ${msg}`);
    }
    if (browserName !== 'webkit') {
      // Not WebKit: the hook does nothing (one more wait past the last reply's 1.5 s).
      await page.waitForTimeout(2500);
      const w = await readWatch(page);
      expect(w.events, 'no row is ever marked outside WebKit').toEqual([]);
      console.log(`[layer-release] ${browserName}: ${w.events.length} marks after ${REPLIES} replies`);
    }
    expect((await stillMarked(page)).inPage).toBe(0);
    expect(s.errors).toEqual([]);
  });

  test('a reader scrolled up when the reply settles gets no release', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'the release runs in WebKit only');
    const s = await openSession(page);
    // A real wheel up, well away from the live end.
    const box = (await s.hist.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -500); await page.waitForTimeout(60); }
    await expect.poll(() => fromBottom(s.hist), { timeout: 5000 }).toBeGreaterThan(1500);
    const endedAt = await streamAndSettle(s, 1);
    await page.waitForTimeout(3000);
    expect(await fromBottom(s.hist), 'the reader stays scrolled up').toBeGreaterThan(1500);
    const w = await readWatch(page);
    expect(w.events.filter((e) => e.t > endedAt), 'no row marked for a reader who scrolled up').toEqual([]);
    expect((await stillMarked(page)).inPage).toBe(0);
    expect(s.errors).toEqual([]);
  });

  test('rows holding the selection or the focus are never marked, and keep them', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'the release runs in WebKit only');
    const s = await openSession(page);
    // A row 600 to 3000 px above the view: inside the release range (200 px to 4000 px above).
    const pickRow = (kind: 'selection' | 'focus') => s.hist.evaluate((el, kind) => {
      const view = el.getBoundingClientRect();
      const row = [...el.children].find((r): r is HTMLElement => {
        if (!(r instanceof HTMLElement) || r.tagName !== 'DIV' || !r.matches('[data-msg-index]')) return false;
        const above = view.top - r.getBoundingClientRect().bottom;
        if (above < 600 || above > 3000) return false;
        return kind === 'focus' ? !!r.querySelector('button') : (r.textContent ?? '').length > 40;
      });
      if (!row) return null;
      (window as any).__relGuard[kind] = row;
      return row.getAttribute('data-msg-index');
    }, kind);
    const timerOf = async (endedAt: number) => (await readWatch(page)).timers.find((t) => t.at > endedAt) ?? null;
    // A selection in the column pauses its follow of the live end and holds the stream block
    // it overlaps (selection-guard.ts), so a selection made before the turn ends leaves the
    // reader a whole reply above the end, where no release runs. The selection is made after
    // the absorption instead, inside the hook's 1.5 s wait, with the reader at the end.
    const atEnd = () => expect.poll(() => fromBottom(s.hist), { timeout: 10_000 }).toBeLessThanOrEqual(2);

    // ── The selection: made after the absorption, before the hook's wait runs ──
    let selected = '';
    let selectedAt = 0;
    await page.evaluate(() => { (window as any).__relHoldWait = true; });
    const endedSel = await streamAndSettle(s, 1, {
      afterAbsorb: async () => {
        await atEnd();
        const selRow = await pickRow('selection');
        expect(selRow, 'a row above the view to select in').not.toBeNull();
        selected = await s.hist.evaluate((el, idx) => {
          // A reader's selection starts with a press into the text, which takes focus out of the composer.
          (document.activeElement as HTMLElement | null)?.blur();
          const row = el.querySelector(`:scope > [data-msg-index="${idx}"]`)!;
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent ?? '').trim().length > 20 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
          const text = walker.nextNode()!;
          const range = document.createRange();
          range.setStart(text, 2); range.setEnd(text, 18);
          const sel = document.getSelection()!;
          sel.removeAllRanges(); sel.addRange(range);
          return sel.toString();
        }, selRow);
        selectedAt = await page.evaluate(() => { (window as any).__relHoldWait = false; return performance.now(); });
        expect(selected.length).toBeGreaterThan(0);
      },
    });
    const relSel = await releaseAfter(page, endedSel);
    const selNow = await page.evaluate(() => document.getSelection()?.toString() ?? '');
    console.log(`[layer-release] selection pass: ${JSON.stringify(relSel)} timer=${JSON.stringify(await timerOf(endedSel))} kept="${selNow}"`);
    const selTimer = await timerOf(endedSel);
    expect(selTimer?.firedAt ?? 0, 'the selection was made before the wait ran').toBeGreaterThan(selectedAt);
    expect(selNow, 'the selection survives').toBe(selected);
    expect(relSel, 'the release still ran for the other rows').not.toBeNull();
    expect(relSel!.marked).toBeGreaterThan(0);
    // The selection is let go: its row may be released from now on.
    await page.evaluate(() => { document.getSelection()?.removeAllRanges(); delete (window as any).__relGuard.selection; });

    // ── The focus: a button of a row above the view ──
    let focusedLabel: string | null = null;
    const endedFocus = await streamAndSettle(s, 2, {
      beforeEnd: async () => {
        await atEnd();
        const focusRow = await pickRow('focus');
        expect(focusRow, 'a row above the view with a button').not.toBeNull();
        focusedLabel = await s.hist.evaluate((el, idx) => {
          const btn = el.querySelector(`:scope > [data-msg-index="${idx}"]`)!.querySelector('button') as HTMLButtonElement;
          btn.focus({ preventScroll: true });
          (window as any).__relFocused = btn;
          return document.activeElement === btn ? (btn.getAttribute('aria-label') || btn.textContent || 'button') : null;
        }, focusRow);
        expect(focusedLabel, 'the button took the focus').not.toBeNull();
      },
    });
    const relFocus = await releaseAfter(page, endedFocus);
    const stillFocused = await page.evaluate(() => document.activeElement === (window as any).__relFocused);
    console.log(`[layer-release] focus pass on "${focusedLabel}": ${JSON.stringify(relFocus)} timer=${JSON.stringify(await timerOf(endedFocus))} focused=${stillFocused}`);
    expect(stillFocused, 'the focus survives').toBe(true);
    expect(relFocus, 'the release still ran for the other rows').not.toBeNull();
    expect(relFocus!.marked).toBeGreaterThan(0);

    const w = await readWatch(page);
    console.log(`[layer-release] guard hits: ${JSON.stringify(w.guardHits)} (passes at ${Math.round(relSel!.at)} and ${Math.round(relFocus!.at)})`);
    expect(w.guardHits, 'rows holding the selection or the focus are never marked').toEqual([]);
    expect((await stillMarked(page)).inPage).toBe(0);
    expect(s.errors).toEqual([]);
  });

  test('closing the column during the wait leaves no row marked', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'the release runs in WebKit only');
    const s = await openSession(page);
    // The wait is held until the close (a loaded host can take longer than the wait to click).
    await page.evaluate(() => { (window as any).__relHoldWait = true; });
    const endedAt = await streamAndSettle(s, 1, { absorb: false });
    // Close as soon as the hook's 1.5 s wait has started.
    await expect.poll(async () => (await readWatch(page)).timers.some((t) => t.at > endedAt), { timeout: 5000 }).toBe(true);
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`);
    await panel.getByRole('button', { name: 'Close session panel' }).click();
    await expect(panel).toHaveCount(0);
    await page.evaluate(() => { (window as any).__relHoldWait = false; });
    await page.waitForTimeout(2500);
    const w = await readWatch(page);
    const timer = w.timers.find((t) => t.at > endedAt)!;
    console.log(`[layer-release] close during the wait: timer ${JSON.stringify(timer)}`);
    expect(timer.clearedAt, 'the unmount cleared the wait before it ran').toBeDefined();
    expect(timer.firedAt, 'the wait never ran').toBeUndefined();
    expect(w.events.filter((e) => e.t > endedAt), 'no row marked after the column closed').toEqual([]);
    expect(await stillMarked(page)).toEqual({ inPage: 0, everMarked: 0, leftMarked: 0 });
    expect(s.errors).toEqual([]);
  });

  test('closing the column between the two frames puts every row back', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'the release runs in WebKit only');
    const s = await openSession(page);
    await page.evaluate(() => { (window as any).__relWatch.holdSecond = true; });
    await streamAndSettle(s, 1);
    // The first frame ran, the second is held: the rows are marked right now.
    await expect.poll(async () => (await readWatch(page)).heldCount, { timeout: 5000 }).toBeGreaterThan(0);
    const during = await stillMarked(page);
    expect(during.inPage, 'rows are marked between the frames').toBeGreaterThan(0);
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`);
    await panel.getByRole('button', { name: 'Close session panel' }).click();
    await expect(panel).toHaveCount(0);
    // A frame that comes late after all must find nothing to do.
    await page.evaluate(() => (window as any).__relReleaseHeld());
    await page.waitForTimeout(500);
    const after = await stillMarked(page);
    const w = await readWatch(page);
    console.log(`[layer-release] between frames: marked ${during.inPage}, after close ${JSON.stringify(after)}, held frame cancelled ${w.heldCancelled}`);
    expect(after.inPage).toBe(0);
    expect(after.leftMarked, 'every marked row, detached ones included, is put back').toBe(0);
    expect(w.heldCancelled, 'the unmount cancelled the pending frame').toBeGreaterThan(0);
    expect(s.errors).toEqual([]);
  });
});
