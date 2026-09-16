/**
 * Shared harness for the code-block horizontal-scrollbar cases.
 *
 * Reported 2026-09-15 (Mac app, narrow session column): a code block wider than
 * its column grew a horizontal scrollbar, and the block's bottom edge plus that
 * scrollbar painted over the first line of the paragraph after it. Wide columns
 * (no scrollbar) were fine, which is why it read as "some UI issue when it is
 * narrow".
 *
 * Mechanism: with `overflow-x: auto` the track appears only when the column gets
 * narrow, and WebKit lays that late track out inside the `<pre>` alone — the block
 * grew 6px while its ancestors kept the height they were sized at. The fix
 * reserves the track from the first layout pass (`overflow-x: scroll`) and
 * subtracts its measured cost from the bottom padding, so the invariant asserted
 * here is that the block's box is the SAME whether or not it currently overflows.
 *
 * Lives in a helper because the WebKit pin has to be a whole file
 * (`test.use({ browserName })` is per-file, and a CLI flag nobody remembers is not
 * a pin) — see code-block-hscroll-overlap.webkit.spec.ts.
 *
 * Harness: history is mocked through page.route, so the real client pipeline
 * (history fetch → SessionPanel → markdown renderer → .markdown-body) lays the
 * message out for real; only the data is canned.
 */
import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

export const SESSION_ID = 'pw-code-hscroll';
export const TASK_ID = 'pw-task-code-hscroll';
export const SHOT_DIR = '/tmp/code-block-hscroll';

/** Above every responsive breakpoint (860/768/700/640/560) so nothing re-renders. */
const WIDE = 1900;
const NARROW = 1000;

/**
 * Shape of the reported reply: prose, a heading, a fence that fits at any width,
 * one fence with a line far wider than a narrow column, then the paragraph that
 * got covered. `rich` decides which render path the message takes — one stray tag
 * sends it through RichBlocks (chunk per blank line) instead of one markdown div,
 * and the fence lands as the LAST child of its own chunk there, which is the shape
 * the user hit.
 */
const replyFor = (rich: boolean) => [
  `\`app.run(...)\` is not a cloud primitive, it is the one line where ${rich ? '<b>Flask</b>' : 'Flask'} starts an HTTP server.`,
  '',
  '### Does every app have to be an HTTP server',
  '',
  'For the **service** shape yes; for jobs and worker pools no. And "start a server" is three lines in any language:',
  '',
  '```python',
  '# Python, Flask; the platform adds nothing, this is a plain web app',
  'from flask import Flask, request',
  'app = Flask(__name__)',
  '@app.post("/")',
  'def handle(): return {"ok": True, "got": request.get_json()}',
  'app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))',
  '```',
  '',
  '```go',
  '// Go, standard library, three lines as well',
  'http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })',
  'http.ListenAndServe(":"+os.Getenv("PORT"), nil)',
  '```',
  '',
  'COVERED-LINE If you want the handler-only experience there is a functions framework that wraps `def handler(request)` in an HTTP server for you, and buildpacks produce the image.',
  '',
  '**Kubernetes has no such contract**: it only runs processes and has no opinion about HTTP.',
].join('\n');

// A fence that fits at every width: its reserved track must stay invisible (no
// thumb on a block that cannot scroll) and cost no extra bottom space.
const historyFor = (rich: boolean) => [
  {
    role: 'user',
    text: 'Does every Cloud Run app need to be an HTTP server?\n\n```sh\ngcloud run deploy --source .\n```',
    timestamp: '2026-01-01T00:00:00.000Z',
  },
  { role: 'assistant', text: replyFor(rich), timestamp: '2026-01-01T00:00:01.000Z' },
];

export function mockSession(page: Page, rich: boolean) {
  const history = historyFor(rich);
  const record = {
    claudeSessionId: SESSION_ID,
    taskId: TASK_ID,
    project: 'Walnut',
    process_status: 'idle',
    mode: 'bypass',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: new Date().toISOString(),
    messageCount: history.length,
    title: 'Code block scrollbar session',
  };
  return Promise.all([
    page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
      if (request.url().includes('/history')) return route.fallback();
      await route.fulfill({ json: { session: { ...record } } });
    }),
    page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const since = new URL(route.request().url()).searchParams.get('since');
      if (since !== null) return route.fulfill({ json: { messages: [], cursor: history.length, delta: true } });
      return route.fulfill({ json: { messages: history, cursor: history.length, delta: false } });
    }),
  ]);
}

interface BlockGeometry {
  preBottom: number;
  nextTop: number;
  overflowsX: boolean;
  offsetHeight: number;
  /** Border-box height as a fraction, for comparing against the parent's. */
  rectHeight: number;
  /** Room the horizontal track takes inside the box (0 on overlay-scrollbar engines). */
  reservedPx: number;
  paddingBottomPx: number;
  /** `--wn-scrollbar-h` as published by web/src/utils/scrollbar-metrics.ts. */
  varPx: number;
  chunked: boolean;
  parentRectHeight: number;
}

/** Geometry of the Go fence (the wide one) and the paragraph right after it. */
function measure(page: Page): Promise<BlockGeometry> {
  return page.evaluate(() => {
    const pres = Array.from(document.querySelectorAll('.session-history .markdown-body pre'));
    const pre = pres.find((el) => el.textContent?.includes('ListenAndServe')) as HTMLElement | undefined;
    if (!pre) throw new Error('go fence not rendered');
    const paras = Array.from(document.querySelectorAll('.session-history .markdown-body p'));
    const next = paras.find((el) => el.textContent?.includes('COVERED-LINE')) as HTMLElement | undefined;
    if (!next) throw new Error('paragraph after the fence not found');
    const cs = getComputedStyle(pre);
    const rootVar = getComputedStyle(document.documentElement).getPropertyValue('--wn-scrollbar-h');
    const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const parent = pre.parentElement as HTMLElement;
    return {
      preBottom: pre.getBoundingClientRect().bottom,
      nextTop: next.getBoundingClientRect().top,
      overflowsX: pre.scrollWidth > pre.clientWidth,
      offsetHeight: pre.offsetHeight,
      rectHeight: pre.getBoundingClientRect().height,
      reservedPx: Math.round(pre.offsetHeight - pre.clientHeight - borders),
      paddingBottomPx: parseFloat(cs.paddingBottom),
      varPx: parseFloat(rootVar) || 0,
      chunked: parent.classList.contains('rich-chunk'),
      parentRectHeight: parent.getBoundingClientRect().height,
    };
  });
}

async function openSession(page: Page, rich: boolean) {
  await mockSession(page, rich);
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.session-history .markdown-body pre', { timeout: 15_000 });
}

/**
 * The reported case, end to end: a fence that fit while the column was wide and
 * overflows once it is narrow may not move the paragraph under itself.
 */
export async function expectNoOverlapWhenNarrowed(page: Page, rich: boolean) {
  await page.setViewportSize({ width: WIDE, height: 900 });
  await openSession(page, rich);
  await expect(page.locator('.session-history').getByText('COVERED-LINE', { exact: false })).toBeVisible();

  const wide = await measure(page);
  console.log('[code-hscroll] wide geometry', JSON.stringify(wide));
  mkdirSync(SHOT_DIR, { recursive: true });
  const label = `${rich ? 'rich' : 'plain'}`;
  await page.locator('.session-history .session-msg-user').first()
    .screenshot({ path: `${SHOT_DIR}/user-fence-fits-${label}.png`, scale: 'css' });

  // Measured right after the resize, deliberately: a later layout pass can heal
  // the stale-ancestor state, and the bug the user sees is the one the resize's
  // own pass produced.
  await page.setViewportSize({ width: NARROW, height: 900 });
  const geo = await measure(page);
  console.log('[code-hscroll] narrow geometry', JSON.stringify(geo));

  const pre = page.locator('.session-history .markdown-body pre', { hasText: 'ListenAndServe' });
  await pre.scrollIntoViewIfNeeded();
  const box = await pre.boundingBox();
  if (box) {
    // Both fences plus the paragraph after them: the fitting one must show no
    // thumb, the wide one a thumb, and neither may touch the paragraph.
    await page.screenshot({
      path: `${SHOT_DIR}/fences-${label}.png`,
      scale: 'css',
      clip: {
        x: Math.max(0, box.x - 8),
        y: Math.max(0, box.y - 190),
        width: Math.min(NARROW, box.width + 16),
        height: box.height + 270,
      },
    });
  }

  // Preconditions: the fence fit while wide and overflows now, otherwise no
  // scrollbar was ever involved and the rest proves nothing.
  expect(wide.overflowsX).toBe(false);
  expect(geo.overflowsX).toBe(true);

  // THE BUG: the gap between fence and paragraph is the fence's margin in both
  // states. It used to shrink by the scrollbar's height (8px → 2px, and in the Mac
  // app the paragraph's first line sat under the block).
  const gapWide = wide.nextTop - wide.preBottom;
  const gapNarrow = geo.nextTop - geo.preBottom;
  expect(Math.abs(gapNarrow - gapWide)).toBeLessThan(2);

  // THE MECHANISM: overflowing changed nothing about the box, so no ancestor can
  // be sized for an older version of it. (Both are 0 on Chromium, which Playwright
  // launches with --hide-scrollbars — that project pins the arithmetic below, and
  // the WebKit file pins the overlap itself.)
  expect(geo.reservedPx).toBe(wide.reservedPx);
  expect(geo.offsetHeight).toBe(wide.offsetHeight);
  // A parent shorter than its only child is the stale-ancestor signature. Rect vs
  // rect: offsetHeight is rounded, and a 1.5-line-height chunk lands on .5.
  expect(geo.parentRectHeight).toBeGreaterThanOrEqual(geo.rectHeight - 1);

  // THE COMPENSATION: the reserved strip is part of the block's 12px bottom edge,
  // never dead space added to it. Also proves main.tsx published the measurement.
  expect(geo.reservedPx).toBe(geo.varPx);
  expect(geo.paddingBottomPx + geo.reservedPx).toBeCloseTo(12, 0);

  // Repeat the resize: a user drags the column back out and in again, and every
  // pass must land on the same geometry.
  for (const width of [WIDE, NARROW, WIDE, NARROW]) {
    await page.setViewportSize({ width, height: 900 });
    const again = await measure(page);
    expect(again.offsetHeight).toBe(wide.offsetHeight);
    expect(again.nextTop - again.preBottom).toBeCloseTo(gapWide, 0);
  }
}

/**
 * Every surface that re-declares the code-block geometry keeps the same contract.
 *
 * The base rule reserves the horizontal track up front, so each surface's bottom
 * padding has to subtract what the track actually costs — otherwise the reserved
 * strip becomes dead space (or, if a surface re-declares `overflow-x: auto`, the
 * late-scrollbar overlap comes straight back on a narrow panel). Four surfaces
 * re-declare it, at three different design scales, and two more WRAP and must pay
 * nothing at all.
 *
 * The wrapping payload is ONE unbreakable token on purpose: `white-space: pre-wrap`
 * alone breaks at spaces, so a spaces-everywhere fixture passes no matter what the
 * CSS says. This is the shape (base64 blob, hash, long path) that used to overflow
 * sideways and bring the overlap back into those panels.
 */
export async function expectReservedTrackContract(page: Page) {
  await openSession(page, false);

  const surfaces = await page.evaluate(() => {
    const long = 'Q'.repeat(600);
    // [classes to nest, design bottom edge in px, must wrap]
    const cases: [string[], number, boolean][] = [
      [['markdown-body'], 12, false],
      [['context-markdown', 'markdown-body'], 12, false],
      [['todo-detail-note', 'markdown-body'], 6, false],
      [['session-diff-rendered', 'markdown-body'], 14, false],
      [['chat-tool-block-result', 'markdown-body'], 0, true],
      [['claude-stream-text', 'markdown-body'], 0, true],
    ];
    return cases.map(([classes, designBottom, wraps]) => {
      // Nested hosts, because two of these selectors are descendant ones
      // (`.session-diff-rendered .markdown-body pre`) and two are same-element
      // (`.todo-detail-note.markdown-body pre`) — nesting satisfies both.
      const outer = document.createElement('div');
      let host = outer;
      for (const cls of classes) {
        const el = document.createElement('div');
        el.className = cls;
        host.appendChild(el);
        host = el;
      }
      host.className = classes.join(' ');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = long;
      pre.appendChild(code);
      host.appendChild(pre);
      document.querySelector('.session-history')!.appendChild(outer);
      const cs = getComputedStyle(pre);
      const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const out = {
        surface: classes.join(' '),
        designBottom,
        wraps,
        whiteSpace: cs.whiteSpace,
        overflowX: cs.overflowX,
        overflowsX: pre.scrollWidth > pre.clientWidth,
        reservedPx: Math.round(pre.offsetHeight - pre.clientHeight - borders),
        paddingBottomPx: parseFloat(cs.paddingBottom),
        varPx: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wn-scrollbar-h')) || 0,
      };
      outer.remove();
      return out;
    });
  });
  console.log('[code-hscroll] surfaces', JSON.stringify(surfaces));

  for (const s of surfaces) {
    if (s.wraps) {
      expect(s.whiteSpace, s.surface).toBe('pre-wrap');
      expect(s.overflowX, s.surface).toBe('auto');
      // It really wraps, even with no break opportunity in the text…
      expect(s.overflowsX, s.surface).toBe(false);
      // …so nothing is reserved and no compensation is owed.
      expect(s.reservedPx, s.surface).toBe(0);
      continue;
    }
    // Reserved from the first layout pass, so the box can never grow late.
    expect(s.overflowX, s.surface).toBe('scroll');
    expect(s.reservedPx, s.surface).toBe(s.varPx);
    // The reserved strip is PART of the surface's bottom edge, never added to it.
    expect(s.paddingBottomPx + s.reservedPx, s.surface).toBeCloseTo(s.designBottom, 0);
  }
}
