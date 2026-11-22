/**
 * The session chat reads cleanly (2026-11-21, the UI audit of the user's own chats:
 * the agent's lines ran near 750 px at a 1280 px window, headings, paragraphs and
 * lists in one dense block; the turn's "Worked for" line read like a grey footnote;
 * a VP chat drew the folder-gone notice at its top and the same failure with the same
 * button again above the composer). web/src/styles/chat-reading.css holds the layout.
 *
 * Measured here, on a long reply with every block kind:
 *   - the timeline is one reading column (about 75 characters of prose), centred in a wide
 *     panel with the composer under it; every row, code block, table and the person's bubble
 *     stays inside it (a long code line scrolls in its block);
 *   - headings follow one scale (15 px titles, 14 px bold), weight 600;
 *   - the turn's line is secondary grey (not muted), its chevron shows, and it fills on hover;
 *   - one condition is one notice: a folder-gone session with a message the server parked
 *     for it shows one "Continue in a new folder" button, and no two notices repeat;
 *   - no row starts under a header: the history pads its scroll stops past the glass
 *     header, and in the Files split the chat's first row sits below its "Chat" bar.
 *
 * History and the WS are mocked (mock-session-harness.ts).
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { MOCK_SESSION_ID as SID, mockSession, open } from './mock-session-harness';

const SHOTS = process.env.CHAT_READING_SHOTS ?? '/tmp/chat-reading';
const at = (n: number) => new Date(Date.UTC(2026, 10, 21, 6, 0, n)).toISOString();
const SENTENCE = 'When you speak English, every chunk of the live preview was heard a second time to see if it should be Chinese, which cost about one second on each chunk.';
const REPLY = [
  "**Today's check** (74 takes, 57 minutes of audio): nothing new was mis-heard.",
  '',
  '## What was slow',
  '',
  `${SENTENCE} ${SENTENCE}`,
  '',
  `- **Fix:** ${SENTENCE}`,
  `- **Verified:** ${SENTENCE}`,
  '',
  '### How the fixer picks a word',
  '',
  `1. that one piece of transcript; ${SENTENCE}`,
  '2. your word list;',
  '',
  '```ts',
  `const line = "${'a long line of code that runs well past the measure of the prose around it '.repeat(3)}";`,
  '```',
  '',
  '| Model | First words | Full text | A note on the run that is long enough to fill the row |',
  '| --- | --- | --- | --- |',
  `| small | 1.1 s | 1.4 s | ${SENTENCE} |`,
  '',
  `Report: /home/someone/.local/state/open-walnut/tasks/9bbc9ae1-1a69-5f9a-acb5-dbdcc13be80c/bench-adapt/report.html`,
].join('\n');

const HISTORY = [
  { role: 'user', text: 'CR_ASK how did the voice check go?', timestamp: at(0) },
  { role: 'assistant', text: REPLY, msgId: 'cr-a1', timestamp: at(90) },
  // The last turn ran a tool: its "Worked for" line sits near the bottom, on screen.
  { role: 'user', text: 'CR_ASK2 and the folder?', timestamp: at(100) },
  { role: 'assistant', text: '', msgId: 'cr-a2', timestamp: at(101), tools: [{ name: 'Bash', toolUseId: 'cr-t1', input: { command: 'ls -la', description: 'List the bench folder' }, result: 'ok' }] },
  { role: 'assistant', text: 'CR_DONE The folder holds the report.', msgId: 'cr-a3', timestamp: at(150) },
];

async function proseReport(hist: Locator) {
  return hist.evaluate((h) => {
    const body = h.querySelector('.session-msg-assistant .markdown-body:not(:empty)') as HTMLElement;
    const blocks = [...body.querySelectorAll(':scope > :is(p, ul, ol, h1, h2, h3, h4, blockquote)')] as HTMLElement[];
    let widest = 0;
    for (const b of blocks) {
      const r = document.createRange(); r.selectNodeContents(b);
      for (const rect of r.getClientRects()) widest = Math.max(widest, rect.width);
    }
    const p = body.querySelector(':scope > p') as HTMLElement;
    const cs = getComputedStyle(p);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    const perChar = ctx.measureText(`${'the quick brown fox jumps over the lazy dog '.repeat(4)}`).width / 176;
    const font = (sel: string) => { const e = body.querySelector(sel); return e ? { size: parseFloat(getComputedStyle(e).fontSize), weight: Number(getComputedStyle(e).fontWeight) } : null; };
    const pre = body.querySelector('pre') as HTMLElement | null;
    const box = h.getBoundingClientRect();
    const col = body.getBoundingClientRect();
    const composer = h.closest('.session-panel')!.querySelector('.session-panel-input .chat-input-container') as HTMLElement | null;
    return {
      panel: box.width,
      column: col.width,
      leftGap: col.left - box.left,
      rightGap: box.right - col.right,
      colLeft: col.left, colRight: col.right,
      composer: composer ? { left: composer.getBoundingClientRect().left, right: composer.getBoundingClientRect().right } : null,
      widest,
      charsPerLine: Math.round(widest / perChar),
      pre: pre ? { width: pre.getBoundingClientRect().width, scrolls: pre.scrollWidth > pre.clientWidth } : null,
      table: (body.querySelector('table') as HTMLElement | null)?.getBoundingClientRect().width ?? 0,
      h2: font(':scope > h2'), h3: font(':scope > h3'), p: font(':scope > p'),
    };
  });
}

/** Every notice and failure line on the panel, as the reader sees them. */
async function noticeTexts(panel: Locator): Promise<string[]> {
  return panel.evaluate((root) => [...root.querySelectorAll('.panel-notice, .session-error-banner, .session-msg-failed-badge, [role="alert"]')]
    .filter((e) => e.getClientRects().length > 0)
    .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean));
}

async function mount(page: Page, width: number, record: Record<string, unknown> = {}, rpcs: Record<string, unknown> = {}) {
  await mockSession(page, HISTORY, 'idle', undefined, { cwd: '/home/someone/projects/voice', ...record }, rpcs);
  const hist = await open(page);
  await page.setViewportSize({ width, height: 900 });
  await expect(hist).toContainText('CR_DONE', { timeout: 60_000 });
  await page.waitForTimeout(500);
  return { hist, panel: page.locator(`.session-panel[data-session-id="${SID}"]`) };
}

for (const width of [1280, 1512]) {
  test(`prose keeps the measure, headings one scale, the turn's line reads as a control (${width}px)`, async ({ page }) => {
    const { hist } = await mount(page, width);
    const r = await proseReport(hist);
    console.log(`[chat-reading] ${width}px ${JSON.stringify(r)}`);
    // One reading column, centred in the wide panel, the composer under it at its width.
    expect(r.panel, 'the panel is wider than the column, or this test measures nothing').toBeGreaterThan(r.column + 200);
    expect(r.column).toBeLessThanOrEqual(497);
    expect(Math.abs(r.leftGap - r.rightGap), `the column is centred (${r.leftGap} | ${r.rightGap})`).toBeLessThanOrEqual(12);
    expect(r.widest, 'a prose line runs past the column').toBeLessThanOrEqual(r.column + 1);
    expect(r.charsPerLine, 'characters on the longest prose line').toBeLessThanOrEqual(84);
    expect(r.charsPerLine, 'characters on the longest prose line').toBeGreaterThanOrEqual(64);
    expect(r.pre!.width, 'a code block stays in the column').toBeLessThanOrEqual(r.column + 1);
    expect(r.pre!.scrolls, 'a long code line scrolls inside its block').toBe(true);
    expect(r.table, 'a table stays in the column').toBeLessThanOrEqual(r.column + 1);
    expect(r.composer, 'the composer is on screen').not.toBeNull();
    expect(Math.abs(r.composer!.left - r.colLeft), 'the composer starts at the column').toBeLessThanOrEqual(16);
    expect(Math.abs(r.composer!.right - r.colRight), 'the composer ends at the column').toBeLessThanOrEqual(16);
    // The standard's sizes: a title is 15 px, the chat text 14 px; a smaller heading is bold text.
    expect(r.h2!.size).toBe(15);
    expect(r.h3!.size).toBeGreaterThanOrEqual(r.p!.size);
    expect(r.h2!.weight).toBe(600);
    expect(r.h3!.weight).toBe(600);
    // Every row and the person's bubble stay inside the same column (the history's content box).
    const rows = await hist.evaluate((h) => {
      const cs = getComputedStyle(h); const box = h.getBoundingClientRect();
      const left = box.left + parseFloat(cs.paddingLeft);
      const right = box.left + h.clientWidth - parseFloat(cs.paddingRight);
      return { left, right, rows: [...h.querySelectorAll('.tool-run-row, .provenance-card, .session-msg-user, .session-show-earlier-btn')]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => ({ what: `${String((e as HTMLElement).className).slice(0, 40)} in ${String(e.parentElement?.className).slice(0, 40)} mr=${getComputedStyle(e).marginRight}`, left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right })) };
    });
    expect(Math.abs(rows.left - r.colLeft), 'the prose fills the content box').toBeLessThanOrEqual(1);
    expect(rows.rows.length).toBeGreaterThan(2);
    for (const row of rows.rows) {
      expect(row.right, `${row.what} runs past the reading column (${rows.right})`).toBeLessThanOrEqual(rows.right + 1);
      expect(row.left, `${row.what} starts left of the reading column (${rows.left})`).toBeGreaterThanOrEqual(rows.left - 6);
    }

    const fold = hist.locator('[data-testid="turn-fold"] > .tool-run-toggle').last();
    await fold.scrollIntoViewIfNeeded();
    await expect(fold).toBeVisible();
    const look = await fold.evaluate((b) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--fg-secondary)'; document.body.appendChild(probe);
      const secondary = getComputedStyle(probe).color; probe.remove();
      const chev = b.querySelector('.process-fold-chevron') as HTMLElement;
      return { color: getComputedStyle(b).color, secondary, chevron: chev.getBoundingClientRect().width, chevOpacity: getComputedStyle(chev).opacity, bg: getComputedStyle(b).backgroundColor };
    });
    expect(look.color, 'the turn line is secondary grey, not muted').toBe(look.secondary);
    expect(await fold.evaluate((b) => getComputedStyle(b).fontSize), 'the turn line is a step smaller than the text').toBe('13px');
    expect(look.chevron).toBeGreaterThanOrEqual(14);
    expect(look.chevOpacity).toBe('1');
    await fold.hover();
    await expect.poll(() => fold.evaluate((b) => getComputedStyle(b).backgroundColor)).not.toBe(look.bg);
    await page.screenshot({ path: `${SHOTS}/${width}-reply.png` }).catch(() => {});
  });
}

test('one condition is one notice: a folder-gone session with a parked message shows one Continue button', async ({ page }) => {
  const gone = '/home/someone/projects/voice/gone-folder';
  const { panel, hist } = await mount(page, 1280, {
    process_status: 'stopped', cwd: gone, cwdGone: { cwd: gone, at: new Date().toISOString(), history: 'found' },
  }, {
    'session:get-queue': { messages: [{
      id: 'cr-q1', message: 'CR_PARKED please carry on', status: 'parked', enqueuedAt: at(100),
      parkedReason: `Session working directory no longer exists: ${gone}`,
    }] },
  });
  await expect(panel.getByTestId('folder-gone-banner')).toBeVisible();
  await expect(hist).toContainText('CR_PARKED');
  const failed = hist.locator('.session-msg-failed-badge');
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText('Not delivered yet');
  await expect(panel.getByRole('button', { name: /in a new folder/ })).toHaveCount(1);
  await expect(hist.getByRole('button', { name: 'Discard' })).toBeVisible();
  const texts = await noticeTexts(panel);
  expect(new Set(texts).size, `a notice shows twice: ${JSON.stringify(texts)}`).toBe(texts.length);
  await page.screenshot({ path: `${SHOTS}/folder-gone-once.png` }).catch(() => {});
});

test('no row starts under a header: scroll stops clear the glass, and the Files split starts below its Chat bar', async ({ page }) => {
  const { panel, hist } = await mount(page, 1512);
  const stops = await hist.evaluate((h) => ({ pad: parseFloat(getComputedStyle(h).scrollPaddingTop), top: parseFloat(getComputedStyle(h).paddingTop) }));
  expect(stops.pad, 'a jump stops where the content starts, clear of the glass header').toBeGreaterThanOrEqual(stops.top - 1);

  await panel.getByRole('button', { name: 'Files', exact: true }).click();
  const chatHist = panel.locator('.session-panel-chat-col .session-history');
  await expect(chatHist).toBeVisible({ timeout: 20_000 });
  // The timeline holds its bottom and loads earlier turns at its top: scroll up until it stays at 0.
  await expect.poll(async () => chatHist.evaluate((h) => { h.scrollTop = 0; return h.scrollTop; }), { timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(300);
  await expect.poll(async () => chatHist.evaluate((h) => { h.scrollTop = 0; return h.scrollTop; })).toBe(0);
  const split = await chatHist.evaluate((h) => {
    const bar = h.closest('.session-panel-chat-col')!.querySelector('.session-chat-bar')!.getBoundingClientRect();
    const box = h.getBoundingClientRect();
    const first = [...h.children].find((c) => c.getClientRects().length > 0 && (c as HTMLElement).offsetHeight > 0) as HTMLElement;
    return { barBottom: bar.bottom, histTop: box.top, firstTop: first.getBoundingClientRect().top, pad: parseFloat(getComputedStyle(h).scrollPaddingTop) };
  });
  expect(split.histTop, 'the chat scroller starts under the Chat bar, not behind it').toBeGreaterThanOrEqual(split.barBottom - 1);
  expect(split.firstTop, 'the first row sits below the Chat bar').toBeGreaterThanOrEqual(split.barBottom + 4);
  expect(split.pad).toBeGreaterThanOrEqual(8);
  await page.screenshot({ path: `${SHOTS}/files-split.png` }).catch(() => {});
});
