/**
 * A code block inside a box that shrinks to fit its content (the person's own
 * bubble, `width: fit-content`) never makes that box change width by itself.
 *
 * The bug (2026-11-17, an Org page VP chat in the Mac app): a pasted message
 * with one fenced line pulsed about 10px wider and narrower, over and over.
 * code-block-actions.ts trims a <pre>'s right padding when a line reaches only
 * into it; in a shrink-to-fit box that trim narrows the box too, so the next
 * measure found the same overflow again, trimmed one more pixel, and at half
 * the padding gave up and put it all back: a loop driven by its own resize.
 *
 * Scenario matrix:
 *  - single-line fences of many lengths in user bubbles, the reported message's
 *    shape among them, each line reaching a few pixels into the <pre>'s right
 *    padding past the width the bubble shrank to (macOS's font metrics did
 *    that by rounding; here a nudge in the fixture's stylesheet does it on
 *    every engine): every bubble keeps one width over many frames
 *  - the same fences in the assistant's full-width reply (padding trim still
 *    works there: a line that only reaches into the padding shows no scrollbar)
 *  - after the window is narrowed and widened again, the bubbles settle again
 */
import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SESSION_ID = 'pw-code-bubble-width';
const TASK_ID = 'pw-task-code-bubble-width';
export const SHOT_DIR = `${process.env.WALNUT_TASK_DIR || '/tmp'}/shots/code-block-bubble-width`;

const WORDS = ['token', 'cache', 'readable', 'bearer', 'holds', 'world', 'json', 'path', 'mcp', 'acme', 'is', 'and'];
/** Lines from 24 to about 110 characters, each a different mix, so their
 *  rendered widths fall on many different fractions of a pixel. */
const LINES = Array.from({ length: 12 }, (_, i) => {
  let s = `/tmp/acme-${'x'.repeat(i % 7)}-token-cache.json`;
  let k = i;
  while (s.length < 24 + i * 5) { s += ` ${WORDS[k % WORDS.length]}`; k += 5; }
  return s;
});

const userText = (line: string, i: number) =>
  `Sam Lee [3:${String(10 + (i % 50)).padStart(2, '0')} PM]\nHey, a quick one to triage:\n\n\`\`\`\n${line}\n\`\`\`\nopen a task check if this is a risk`;

/** The reported message's shape (names and path made neutral). */
const REPORTED = [
  'Sam Lee [3:54 PM]', '', 'Hey, my agent might have found a problem with the demo app, I\u2019ll let you triage:', '',
  '```', '/tmp/acme-mcp-token-cache.json is world-readable and holds bearer tokens', '```', '',
  'Alex Kim [3:55 PM]', '', 'will take a look', '', '[3:55 PM]', '', 'thanks!', '', '[3:55 PM]', '',
  'should be low risk as this is only in the dev', '', '', 'open a task check if this is a risk',
].join('\n');

const history = [
  { role: 'user', text: REPORTED, timestamp: '2025-12-31T23:58:00.000Z' },
  { role: 'assistant', text: 'Looking.', timestamp: '2025-12-31T23:59:00.000Z' },
  ...LINES.flatMap((line, i) => [
    { role: 'user', text: userText(line, i), timestamp: new Date(Date.UTC(2026, 0, 1, 0, i * 2)).toISOString() },
    { role: 'assistant', text: `Noted (${i}):\n\n\`\`\`\n${line}\n\`\`\``, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i * 2 + 1)).toISOString() },
  ]),
];

async function installHarness(page: Page) {
  // Each user bubble's code reaches 4px past the width the bubble shrank to,
  // into the <pre>'s right padding: a zero-width box shifted right adds
  // scrollable overflow without adding to the bubble's fit-content width.
  // That is what macOS WebKit's fractional font metrics gave the reported
  // line; Linux fonts round the other way, so the fixture makes it explicit.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '.session-msg-user .md-code > pre > code::after { content: ""; display: inline-block; width: 0; height: 1px; position: relative; left: 4px; }';
      document.head.appendChild(style);
    });
  });
  const record = {
    claudeSessionId: SESSION_ID,
    taskId: TASK_ID,
    project: 'Walnut',
    process_status: 'stopped',
    mode: 'bypass',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T02:00:00.000Z',
    messageCount: history.length,
    title: 'Code bubble width session',
  };
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({ json: { session: { ...record } } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null) return route.fulfill({ json: { messages: [], cursor: history.length, delta: true } });
    return route.fulfill({ json: { messages: history, cursor: history.length, delta: false } });
  });
}

export async function openSession(page: Page, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await installHarness(page);
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.session-history .session-msg-user .md-code').first()).toBeVisible({ timeout: 15_000 });
  mkdirSync(SHOT_DIR, { recursive: true });
}

/** Each rendered row's width, sampled on `frames` animation frames. Returns the
 *  rows whose width moved, with the widths seen. */
async function movingRows(page: Page, selector: string, frames: number) {
  return page.evaluate(async ({ selector, frames }) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const seen = rows.map(() => new Set<number>());
    const pads = rows.map(() => new Set<string>());
    for (let f = 0; f < frames; f++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      rows.forEach((row, i) => {
        seen[i].add(Math.round(row.getBoundingClientRect().width * 100) / 100);
        pads[i].add(row.querySelector('pre')?.style.paddingRight ?? '');
      });
    }
    return {
      count: rows.length,
      moving: rows.map((row, i) => ({ text: row.querySelector('code')?.textContent ?? '', widths: [...seen[i]], pads: [...pads[i]] }))
        .filter((r) => r.widths.length > 1),
    };
  }, { selector, frames });
}

/** Scroll every row through the viewport once, so each is laid out and
 *  observed (the history renders its tail; earlier rows mount as they come). */
async function visitAllRows(page: Page) {
  await page.evaluate(async () => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.session-history .session-msg'));
    for (const row of rows) {
      row.scrollIntoView({ block: 'center' });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    }
  });
}

export async function expectBubblesKeepTheirWidth(page: Page, engine: string) {
  await openSession(page, 1440);
  await visitAllRows(page);
  // The fixture's 4px nudge lands inside the trim zone (half the padding)
  // only while the stylesheet's padding is at least 8px: a CSS change that
  // moves it fails here, by name, instead of passing for nothing.
  const pad = await page.locator('.session-history .session-msg-user .md-code > pre').first()
    .evaluate((pre) => { const ours = (pre as HTMLElement).style.paddingRight; (pre as HTMLElement).style.paddingRight = ''; const p = parseFloat(getComputedStyle(pre).paddingRight); (pre as HTMLElement).style.paddingRight = ours; return p; });
  expect(pad).toBeGreaterThanOrEqual(8);
  const users = await movingRows(page, '.session-history .session-msg-user', 90);
  // The timeline may keep its oldest rows behind "earlier"; the reported
  // message's shape and most of the others must be sampled.
  expect(users.count).toBeGreaterThanOrEqual(10);
  await expect(page.locator('.session-history .session-msg-user', { hasText: 'acme-mcp-token-cache' })).toHaveCount(1);
  await page.locator('.session-history .session-msg-user').last().screenshot({ path: `${SHOT_DIR}/${engine}-bubble.png` });
  expect(users.moving, 'a user bubble changed width by itself').toEqual([]);
  const replies = await movingRows(page, '.session-history .session-msg-assistant .md-code', 30);
  expect(replies.moving, 'a reply code block changed width by itself').toEqual([]);
}

export async function expectBubblesSettleAfterResize(page: Page) {
  await openSession(page, 1440);
  await visitAllRows(page);
  for (const width of [1100, 1600, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    // Let the resize finish its own refits before judging.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    const users = await movingRows(page, '.session-history .session-msg-user', 60);
    expect(users.moving, `a user bubble changed width by itself at ${width}px`).toEqual([]);
  }
}

/** In a full-width block, a line that reaches only into the right padding still
 *  gets the padding trim: no sideways scroll for a few pixels. */
export async function expectPaddingTrimStillWorks(page: Page) {
  await openSession(page, 1280);
  const frame = page.locator('.session-history .session-msg-assistant .md-code').last();
  await frame.scrollIntoViewIfNeeded();
  await frame.evaluate((f) => {
    const pre = f.querySelector('pre')!;
    const code = pre.querySelector('code')!;
    const pad = parseFloat(getComputedStyle(pre).paddingRight);
    const left = parseFloat(getComputedStyle(pre).paddingLeft);
    // One line that reaches a quarter of the way into the right padding: into it,
    // never past it. An exact width, not a count of characters: a whole number of
    // characters lands anywhere within one character's width, which at some column
    // widths stops short of the padding (2026-11-22, the 496 px reading column).
    const probe = document.createElement('span');
    probe.style.display = 'inline-block';
    probe.style.width = `${pre.clientWidth - left - pad + pad / 4}px`;
    probe.textContent = '\u00a0';
    code.textContent = '';
    code.appendChild(probe);
  });
  // A change of the block's own width makes it measure itself again.
  await frame.evaluate(async (f) => {
    const el = f as HTMLElement;
    const frames = (n: number) => new Promise<void>((r) => { const step = (k: number) => (k ? requestAnimationFrame(() => step(k - 1)) : r()); step(n); });
    el.style.marginRight = '1px';
    await frames(3);
    el.style.marginRight = '';
    await frames(6);
  });
  const fit = await frame.evaluate((f) => {
    const pre = f.querySelector('pre')!;
    return { overflow: pre.scrollWidth - pre.clientWidth, fits: f.hasAttribute('data-fits'), now: pre.style.paddingRight };
  });
  expect(fit.fits, JSON.stringify(fit)).toBe(true);
  expect(fit.overflow, JSON.stringify(fit)).toBeLessThanOrEqual(0);
  expect(fit.now, JSON.stringify(fit)).not.toBe('');
}
