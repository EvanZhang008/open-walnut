/**
 * Code blocks in a session reply: language label, syntax colors, Copy, Wrap
 * (web/src/utils/code-block.ts, code-block-actions.ts, styles/code-block.css).
 *
 * Shared by the Chromium file and the WebKit pin (the Mac app is a WKWebView,
 * and `test.use({ browserName })` is per file). Harness: history through
 * page.route and live deltas through the app's own captured /ws socket, as in
 * rich-html-streaming.spec.ts, so the real client pipeline renders the reply.
 *
 * Scenario matrix:
 *  - a finished reply: each fence framed, labeled, colored; no-language and
 *    unknown-language fences framed and plain; inline code untouched
 *  - Copy: the code alone (no trailing newline), "Copied" then back; twice in a
 *    row; from the keyboard; a click on it never reaches the row's own handlers
 *  - Copy with no clipboard at all: the code is selected and the button says so,
 *    for as long as it stays selected
 *  - a drag from the header selects from where it meets the code
 *  - Wrap: a wide block stops overflowing, the other blocks stay as they were,
 *    the block keeps it when its row is drawn again and across a reload, and
 *    toggling back restores the scroll
 *  - selecting the reply and copying it with the system gesture leaves the
 *    header's words out
 *  - Wrap from a header stuck mid-block: the line under the header stays put
 *  - a short block scrolled up under the header glass: its sticky header stays
 *    inside the block, never sliding over the paragraph after it
 *  - a long finished block opens folded with "Show all N lines"; Copy takes
 *    all of it; unfolding sticks across a reload; Fold in its stuck header,
 *    from deep inside it, folds it again with the header kept in place and
 *    focus on "Show all", and that sticks too; a long block watched as it
 *    streamed in stays open when its fence closes
 *  - streaming: a long block arriving delta by delta is framed and colored as it
 *    grows, Copy mid-stream takes what is there, wrap applies to it, and frames
 *    stay short (no main-thread stall)
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

export const SESSION_ID = 'pw-code-actions';
const TASK_ID = 'pw-task-code-actions';
const MSG_ID = 'msg-code-stream-1';
export const SHOT_DIR = `${process.env.WALNUT_TASK_DIR || '/tmp'}/shots/code-block-actions`;

const TS_CODE = [
  'import { readFile } from "node:fs/promises";',
  '',
  '/* Load the config once, then cache it. */',
  'export async function loadConfig(path: string): Promise<Config> {',
  '  const raw = await readFile(path, "utf8");',
  '  return JSON.parse(raw) as Config; // trusted input',
  '}',
].join('\n');
const WIDE_SHELL = 'curl -sS -X POST "https://api.example.com/v1/projects/marina/deployments?wait=true&timeout=600" -H "Content-Type: application/json" -d \'{"ref":"main","env":"staging"}\'';

const REPLY = [
  'Here is the loader:',
  '',
  '```ts',
  TS_CODE,
  '```',
  '',
  'Deploy it with:',
  '',
  '```bash',
  WIDE_SHELL,
  '```',
  '',
  'Output looks like this (call `loadConfig()` first):',
  '',
  '```',
  'deployment 42 queued',
  '```',
  '',
  'AFTER-LAST-BLOCK done.',
].join('\n');

/** An earlier reply with a block long enough to open folded. */
const LONG_CODE = Array.from({ length: 80 }, (_, i) => `export const step${i} = () => run(${i}); // stage ${i}`).join('\n');
const DIFF_CODE = ['--- a/run.ts', '+++ b/run.ts', '-export const run = (n: number) => n;', '+export const run = (n: number, opts: { retries: number; timeoutMs: number } = { retries: 3, timeoutMs: 600 }) => n;'].join('\n');
const EARLIER = ['The full list of steps:', '', '```ts', LONG_CODE, '```', '', 'And the change to run:', '', '```diff', DIFF_CODE, '```', '', 'END-OF-LONG.'].join('\n');

const history = [
  { role: 'assistant', text: EARLIER, timestamp: '2025-12-31T23:59:00.000Z' },
  { role: 'user', text: 'How do I load the config and deploy? Mine does:\n\n```go\nfmt.Println(cfg)\n```', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', text: REPLY, timestamp: '2026-01-01T00:00:01.000Z' },
];

/** A failed copy's words, shown, lie above the block's first line of code. */
async function expectWhyClearOfCode(frame: Locator) {
  const { why, line } = await frame.evaluate((f) => {
    const s = f.querySelector('.md-code-status')!.getBoundingClientRect();
    return { why: s.bottom, line: f.querySelector('code')!.getClientRects()[0]!.top };
  });
  expect(why).toBeLessThanOrEqual(line + 0.5);
}

async function installHarness(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    // Clipboard stand-in: records what Copy wrote; `__clipboardFail` refuses.
    w.__copied = [] as string[];
    w.__clipboardFail = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (t: string) => {
          // `__clipboardHold`: the write waits until the test settles it.
          if (w.__clipboardHold) await new Promise((ok, no) => { w.__held = { ok, no }; });
          if (w.__clipboardFail) throw new Error('denied');
          w.__copied.push(t);
        },
      },
    });
    const origExec = document.execCommand.bind(document);
    document.execCommand = ((cmd: string, ...rest: unknown[]) => {
      if (cmd === 'copy' && w.__clipboardFail) return false;
      return (origExec as any)(cmd, ...rest);
    }) as typeof document.execCommand;
    // Clicks that got past the capture handler (they must not).
    w.__rowClicks = 0;
    window.addEventListener('DOMContentLoaded', () => {
      document.body.addEventListener('click', (e) => {
        if ((e.target as Element).closest?.('.md-code-head')) w.__rowClicks++;
      });
    });
    // The app's /ws socket, captured so tests can inject stream deltas.
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const socketUrl = new URL(String(url), window.location.href);
        if (socketUrl.pathname === '/ws' && !w.__capturedWs) {
          w.__capturedWs = this;
          const origSend = this.send.bind(this);
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            let intercepted = false;
            try {
              const parsed = JSON.parse(data as string);
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                intercepted = true;
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: [], isStreaming: false } }),
                  }));
                }, 10);
              }
            } catch { /* non-JSON */ }
            if (!intercepted) origSend(data);
          };
        }
      }
    } as any;
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as any)[key] = (OrigWebSocket as any)[key]; } catch { /* read-only */ }
      }
    }
  });
  const record = {
    claudeSessionId: SESSION_ID,
    taskId: TASK_ID,
    project: 'Walnut',
    process_status: 'running',
    mode: 'bypass',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: new Date().toISOString(),
    messageCount: history.length,
    title: 'Code block actions session',
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

export async function openSession(page: Page, opts: { width?: number; height?: number; theme?: 'light' | 'dark' } = {}) {
  await page.setViewportSize({ width: opts.width ?? 1280, height: opts.height ?? 900 });
  await installHarness(page);
  if (opts.theme) {
    await page.addInitScript((t) => { try { localStorage.setItem('open-walnut-theme', t); } catch { /* */ } }, opts.theme);
  }
  await page.goto(`/sessions?id=${SESSION_ID}`);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined;
    return ws && ws.readyState === WebSocket.OPEN;
  }, null, { timeout: 15_000 });
  await expect(page.locator('.session-history .md-code').first()).toBeVisible({ timeout: 15_000 });
  mkdirSync(SHOT_DIR, { recursive: true });
}

const reply = (page: Page) => page.locator('.session-history .session-msg-assistant').last();
const block = (page: Page, i: number) => reply(page).locator('.md-code').nth(i);

async function shot(page: Page, name: string, engine: string) {
  const box = await reply(page).boundingBox();
  if (!box) return;
  await page.screenshot({
    path: `${SHOT_DIR}/${engine}-${name}.png`,
    clip: { x: box.x, y: Math.max(0, box.y), width: Math.min(box.width, 1280), height: Math.min(box.height, 880) },
  });
}

export async function expectFramedAndColored(page: Page, engine: string) {
  await openSession(page);
  const blocks = reply(page).locator('.md-code');
  await expect(blocks).toHaveCount(3);
  await expect(blocks.locator('.md-code-lang')).toHaveText(['TypeScript', 'Shell', 'Text']);
  // Colored: a keyword is not drawn in the block's own text color.
  const colors = await block(page, 0).evaluate((frame) => {
    const pre = frame.querySelector('pre')!;
    const kw = frame.querySelector('.token.keyword')!;
    const str = frame.querySelector('.token.string')!;
    const cm = frame.querySelector('.token.comment')!;
    return {
      pre: getComputedStyle(pre).color,
      kw: getComputedStyle(kw).color,
      str: getComputedStyle(str).color,
      comment: getComputedStyle(cm).color,
      kwText: kw.textContent?.trim(),
    };
  });
  expect(colors.kwText).toBe('import');
  expect(colors.kw).not.toBe(colors.pre);
  expect(colors.str).not.toBe(colors.kw);
  expect(colors.comment).not.toBe(colors.pre);
  // The plain block has the frame and no tokens; inline code stays inline.
  await expect(block(page, 2).locator('.token')).toHaveCount(0);
  await expect(reply(page).locator('p code', { hasText: 'loadConfig()' })).toBeVisible();
  // The header sits inside the block, above the first line, not over it.
  const geo = await block(page, 0).evaluate((frame) => {
    const head = frame.querySelector('.md-code-head')!.getBoundingClientRect();
    const pre = frame.querySelector('pre')!.getBoundingClientRect();
    const code = frame.querySelector('pre code')!;
    const range = document.createRange();
    range.selectNodeContents(code);
    const firstLine = range.getClientRects()[0]!;
    return { headTop: head.top, headBottom: head.bottom, preTop: pre.top, firstLineTop: firstLine.top };
  });
  expect(geo.headTop).toBeGreaterThanOrEqual(geo.preTop);
  expect(geo.firstLineTop).toBeGreaterThanOrEqual(geo.headBottom);
  await shot(page, 'framed-light', engine);
}

export async function expectCopyWorks(page: Page) {
  await openSession(page);
  const copy = block(page, 0).getByRole('button', { name: 'Copy TypeScript code' });
  // Copy sits at the header's right end: its left edge moves if its width does.
  const copyX = () => block(page, 0).locator('[data-md-code-action="copy"]').evaluate((b) => b.getBoundingClientRect().left);
  const copyXBefore = await copyX();
  await copy.click();
  await expect(block(page, 0).locator('.md-code-copy-label')).toHaveText('Copied');
  expect(await page.evaluate(() => (window as any).__copied)).toEqual([TS_CODE]);
  // Read out, and the button kept its width.
  await expect(block(page, 0).locator('.md-code-status')).toHaveText('Copied');
  // (By its action, not its name: the name is what changes.)
  const copyBtn = block(page, 0).locator('[data-md-code-action="copy"]');
  // Read out once, from the status region: the button keeps its name.
  await expect(copyBtn).toHaveAttribute('aria-label', 'Copy TypeScript code');
  expect(Math.abs((await copyX()) - copyXBefore)).toBeLessThan(0.5);
  // Back to "Copy" by itself.
  await expect(block(page, 0).locator('.md-code-copy-label')).toHaveText('Copy', { timeout: 4000 });
  await expect(copyBtn).toHaveAttribute('aria-label', 'Copy TypeScript code');
  // Again, and another block: each copy takes its own block, whole.
  await copy.click();
  await block(page, 1).getByRole('button', { name: 'Copy Shell code' }).click();
  expect(await page.evaluate(() => (window as any).__copied)).toEqual([TS_CODE, TS_CODE, WIDE_SHELL]);
  // Keyboard: focus the third block's Copy and press Enter.
  await block(page, 2).getByRole('button', { name: 'Copy code' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__copied.length)).toBe(4);
  expect(await page.evaluate(() => (window as any).__copied[3])).toBe('deployment 42 queued');
  // No click on the header reached the row.
  expect(await page.evaluate(() => (window as any).__rowClicks)).toBe(0);
}

export async function expectCopyFallbackSelects(page: Page) {
  await openSession(page);
  // An older press that fails after a newer one copied says nothing: the
  // reader sees the newer outcome.
  const shell = block(page, 1);
  await page.evaluate(() => { (window as any).__clipboardHold = true; });
  await shell.locator('[data-md-code-action="copy"]').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__held)).toBe(true);
  await page.evaluate(() => {
    const w = window as any;
    w.__clipboardHold = false;
    w.__stale = w.__held;
  });
  await shell.locator('[data-md-code-action="copy"]').click();
  await expect(shell.locator('.md-code-copy-label')).toHaveText('Copied');
  await page.evaluate(() => {
    const w = window as any;
    w.__clipboardFail = true;
    w.__stale.ok();
  });
  await page.waitForTimeout(300);
  await expect(shell.locator('.md-code-copy-label')).toHaveText('Copied');
  await expect(shell.locator('.md-code-status')).not.toHaveAttribute('data-visible', '');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  // A block in the person's bubble is as wide as its code: a failed copy's
  // words do not widen it (or the bubble); they hang under its header.
  const mine = page.locator('.session-history .session-msg-user .md-code').first();
  // In full view (a header stuck mid-block lies over the code anyway).
  await wheelTo(page, mine, -60);
  const wide = () => mine.evaluate((f) => f.getBoundingClientRect().width);
  const mineBefore = await wide();
  await mine.locator('[data-md-code-action="copy"]').click();
  await expect(mine.locator('.md-code-status')).toBeVisible();
  expect(Math.abs((await wide()) - mineBefore)).toBeLessThan(1);
  await expectWhyClearOfCode(mine);
  await page.evaluate(() => { (window as any).__clipboardFail = true; });
  // From the keyboard: focus stays on Copy through the fallback, so Tab
  // carries on from there.
  await block(page, 0).locator('[data-md-code-action="copy"]').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-md-code-action'))).toBe('copy');
  const status = block(page, 0).locator('.md-code-status');
  await expect(status).toBeVisible();
  // Read out whole; on screen, the step to take.
  await expect(status).toHaveText(/^Copy failed, code selected\. Press (\u2318C|Ctrl\+C)$/);
  const hintFits = () => status.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el.lastChild!);
    return r.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5;
  });
  expect(await hintFits()).toBe(true); // not cut short
  await expect(block(page, 0).locator('[data-md-code-action="copy"]')).toHaveAttribute('aria-label', 'Copy TypeScript code');
  // The selection is the code alone: no trailing newline, as Copy gives.
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toBe(TS_CODE);
  // The message selection bar stays away: nothing covers the hint.
  await page.waitForTimeout(400);
  const covered = await status.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(hit && el.contains(hit));
  });
  expect(covered).toBe(false);
  // The hint stays while the code is still selected (a reader who looked
  // away still finds the step to take), past the moment "Copied" shows for.
  await page.waitForTimeout(5200);
  await expect(status).toBeVisible();
  // Nor in a phone-sized window (the layout redraws, so last).
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: size.height });
  // The hint already showing is laid out again for the narrower block: whole.
  await expect(status).toBeVisible();
  await expect.poll(hintFits).toBe(true);
  await expectWhyClearOfCode(block(page, 0));
  // With a selection already on the page (the last attempt's, in block 0), a
  // failed copy of another block leaves the reader where they were: the
  // timeline's selection anchoring (selection-guard.ts) must not read the new
  // selection's distance from the old one as content moving.
  const other = block(page, 2);
  await wheelTo(page, other, -120);
  const topOf = () => other.evaluate((f) => f.getBoundingClientRect().top);
  const before = await topOf();
  const copyAt = () => other.locator('[data-md-code-action="copy"]').evaluate((b) => b.getBoundingClientRect().right);
  const copyBefore = await copyAt();
  await other.locator('[data-md-code-action="copy"]').click();
  await expect(other.locator('.md-code-status')).toBeVisible();
  await page.waitForTimeout(400);
  expect(Math.abs((await topOf()) - before)).toBeLessThan(2);
  // Copy stays under the finger; the words cover none of the code.
  expect(Math.abs((await copyAt()) - copyBefore)).toBeLessThan(1);
  await expectWhyClearOfCode(other);
  await block(page, 0).locator('[data-md-code-action="copy"]').click();
  await expect(status).toBeVisible();
  expect(await hintFits()).toBe(true);
  // The language label stays beside the hint.
  await expect(block(page, 0).locator('.md-code-lang')).toBeVisible();
  await page.setViewportSize(size);
}

export async function expectWrapToggles(page: Page, engine: string) {
  // Narrow enough that the shell line overflows.
  await openSession(page, { width: 900 });
  const overflow = () => block(page, 1).evaluate((f) => {
    const pre = f.querySelector('pre')!;
    return pre.scrollWidth > pre.clientWidth + 1;
  });
  expect(await overflow()).toBe(true);
  const wrap = block(page, 1).locator('[data-md-code-action="wrap"]');
  await expect(wrap).toHaveAttribute('aria-pressed', 'false');
  await expect(wrap).toBeVisible();
  // A block with no long line has nothing to wrap: no Wrap on it, and its
  // code is no Tab stop (nothing to scroll).
  await expect(block(page, 2).locator('[data-md-code-action="wrap"]')).toBeHidden();
  await expect(block(page, 2).locator('pre')).toHaveAttribute('tabindex', '-1');
  await expect(block(page, 1).locator('pre')).toHaveAttribute('tabindex', '0');
  const heightBefore = await block(page, 1).evaluate((f) => f.getBoundingClientRect().height);
  await wrap.click();
  await expect(wrap).toHaveAttribute('aria-pressed', 'true');
  // One name; pressed says it is on.
  await expect(wrap).toHaveAttribute('aria-label', 'Wrap long lines');
  expect(await overflow()).toBe(false);
  expect(await block(page, 1).evaluate((f) => f.getBoundingClientRect().height)).toBeGreaterThan(heightBefore);
  // Only this block: the others keep their own state.
  const pressed = await reply(page).locator('[data-md-code-action="wrap"]').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-pressed')));
  expect(pressed.filter((p) => p === 'true')).toHaveLength(1);
  expect(await reply(page).locator('.md-code[data-wrap]').count()).toBe(1);
  // The text is still the code, nothing inserted where lines wrap.
  expect(await block(page, 1).locator('pre code').evaluate((c) => c.textContent)).toBe(WIDE_SHELL + '\n');
  // The line's continuation starts deeper than the line itself.
  const starts = await block(page, 1).locator('.md-code-ln').first().evaluate((ln) => {
    const r = document.createRange();
    r.selectNodeContents(ln);
    const rows = [...r.getClientRects()].filter((x) => x.width > 0);
    const lefts = [...new Set(rows.map((x) => Math.round(x.left)))];
    return { rows: new Set(rows.map((x) => Math.round(x.top))).size, lefts };
  });
  expect(starts.rows).toBeGreaterThan(1);
  expect(Math.max(...starts.lefts) - Math.min(...starts.lefts)).toBeGreaterThan(8);
  // No line ends on a hyphen: each joined pair sits on one line.
  const pairs = await block(page, 1).evaluate((f) => [...f.querySelectorAll('.md-code-nb')].map((e) => e.getClientRects().length));
  expect(pairs.length).toBeGreaterThan(3);
  expect(pairs.every((n) => n === 1)).toBe(true);
  // The paragraph after a wrapped block is not covered by it.
  const gap = await reply(page).evaluate((r) => {
    const frames = r.querySelectorAll('.md-code');
    const next = [...r.querySelectorAll('p')].find((p) => p.textContent?.includes('Output looks like'))!;
    return next.getBoundingClientRect().top - frames[1]!.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(4);
  await shot(page, 'wrapped', engine);

  // The row drawn again from the message's cached HTML (as a remount does):
  // the block is wrapped again, its button says so, and no other block is.
  await reply(page).locator('.markdown-body').first().evaluate((body) => { body.innerHTML = body.innerHTML.replace(/ data-wrap=""/g, ''); });
  expect(await overflow()).toBe(false);
  const wrapAfter = block(page, 1).locator('[data-md-code-action="wrap"]');
  await expect(wrapAfter).toHaveAttribute('aria-pressed', 'true');
  expect(await reply(page).locator('.md-code[data-wrap]').count()).toBe(1);
  // A reload keeps it too (this tab only), still on that block alone.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(block(page, 1)).toBeVisible({ timeout: 15_000 });
  await expect(wrapAfter).toHaveAttribute('aria-pressed', 'true');
  expect(await overflow()).toBe(false);
  expect(await reply(page).locator('.md-code[data-wrap]').count()).toBe(1);
  // Back off: scrolls sideways again.
  await wrapAfter.click();
  await expect(wrapAfter).toHaveAttribute('aria-pressed', 'false');
  expect(await overflow()).toBe(true);
  // Nothing is kept past the tab.
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /wrap/i.test(k)))).toEqual([]);

  // Two messages holding the same block are two blocks: wrapping one leaves
  // the other (and the original) alone.
  await block(page, 1).evaluate((f) => {
    for (const id of ['pw-msg-a', 'pw-msg-b']) {
      const row = document.createElement('div');
      row.setAttribute('data-message-id', id);
      row.className = 'markdown-body';
      row.appendChild(f.cloneNode(true));
      f.parentElement!.appendChild(row);
    }
  });
  const inMsg = (id: string) => page.locator(`[data-message-id="${id}"] .md-code`);
  await inMsg('pw-msg-a').locator('[data-md-code-action="wrap"]').click();
  await expect(inMsg('pw-msg-a')).toHaveAttribute('data-wrap', '');
  expect(await inMsg('pw-msg-b').evaluate((f) => f.hasAttribute('data-wrap'))).toBe(false);
  expect(await block(page, 1).evaluate((f) => f.hasAttribute('data-wrap'))).toBe(false);
}

export async function expectSelectionSkipsHeader(page: Page) {
  await openSession(page);
  const text = await reply(page).evaluate((r) => {
    const body = r.querySelector('.markdown-body')!;
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString();
  });
  expect(text).toContain('export async function loadConfig');
  expect(text).toContain('AFTER-LAST-BLOCK');
  expect(text).not.toMatch(/\bCopy\b/);
  expect(text).not.toMatch(/\bWrap\b/);
  expect(text).not.toContain('TypeScript');
  // A drag that starts on the header (not selectable) selects from where the
  // pointer first meets the code (here its first line, right under the
  // header) to where it is let go, not nothing.
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await wheelTo(page, block(page, 0), -60);
  const lines = block(page, 0).locator('.md-code-ln');
  const label = (await block(page, 0).locator('.md-code-lang').boundingBox())!;
  const l2 = (await lines.nth(2).boundingBox())!;
  const l4 = (await lines.nth(4).boundingBox())!;
  await page.mouse.move(label.x + 10, label.y + label.height / 2);
  await page.mouse.down();
  await page.mouse.move(l2.x + 4, l2.y + l2.height / 2, { steps: 4 });
  await page.mouse.move(l4.x + 60, l4.y + l4.height / 2, { steps: 4 });
  await page.mouse.up();
  const dragged = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(dragged.length).toBeGreaterThan(20);
  expect(TS_CODE).toContain(dragged);
  expect(dragged).toContain('Load the config');
  expect(dragged).not.toContain('JSON.parse');
  // Pressed on the language: from the start of the first line reached.
  const at = TS_CODE.indexOf(dragged);
  expect(at === 0 || TS_CODE[at - 1] === '\n', JSON.stringify(dragged)).toBe(true);
  // A slow drag straight down from the header's middle starts where the
  // pointer meets the first line, not at that line's start (the room above
  // the first line is not the code).
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const head = (await block(page, 0).locator('.md-code-head').boundingBox())!;
  const x = head.x + 200;
  await page.mouse.move(x, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, l2.y + l2.height / 2, { steps: 30 });
  await page.mouse.up();
  const slow = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(slow.length).toBeGreaterThan(10);
  expect(TS_CODE).toContain(slow);
  expect(slow.startsWith('import')).toBe(false);
}

export async function expectHeaderStaysInBlock(page: Page) {
  // Short enough that the reply scrolls under the session header's glass.
  await openSession(page, { height: 420 });
  // The first block: enough of the reply below it to scroll it fully past.
  const steps = await block(page, 0).evaluate(async (f) => {
    // Where the timeline's visible area starts: under the header glass when
    // the glass overlays the scroller, else the scroller's own top (a banner
    // or a tab bar in flow above it).
    const visibleTop = (sc: Element) => {
      const glass = document.querySelector('.session-panel-header')?.getBoundingClientRect();
      const top = sc.getBoundingClientRect().top;
      return glass && glass.bottom > top ? glass.bottom : top;
    };
    const scroller = f.closest('.session-history') as HTMLElement;
    const glass = visibleTop(scroller);
    const out: { frameBottom: number; headTop: number; headBottom: number; frameTop: number }[] = [];
    // Walk the block's top from just under the visible top to fully past it.
    for (let d = -20; d <= f.getBoundingClientRect().height + 20; d += 15) {
      scroller.scrollTop += f.getBoundingClientRect().top - glass + d;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const fr = f.getBoundingClientRect();
      const h = f.querySelector('.md-code-head')!.getBoundingClientRect();
      out.push({ frameTop: fr.top, frameBottom: fr.bottom, headTop: h.top, headBottom: h.bottom });
    }
    return out;
  });
  expect(steps.some((s) => s.headTop > s.frameTop + 1), JSON.stringify(steps)).toBe(true); // it did stick
  for (const s of steps) {
    expect(s.headTop).toBeGreaterThanOrEqual(s.frameTop - 0.5);
    expect(s.headBottom).toBeLessThanOrEqual(s.frameBottom + 0.5);
  }
  // In a tall window the same block fits in half the timeline: seen whole,
  // its header scrolls with it rather than riding over its few lines.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 1100 });
  await expect(block(page, 0)).toHaveAttribute('data-short', '');
  await expect(block(page, 0).locator('.md-code-head')).toHaveCSS('position', 'relative');
}

export async function expectWrapKeepsPlace(page: Page) {
  // Narrow and short: the first block's long lines overflow, and the reply
  // scrolls far enough to leave its header stuck mid-block.
  await openSession(page, { width: 480, height: 420 });
  // Phone-sized: every block holds its whole code, scrollbar track included
  // (WebKit can add the track after laying the block out; code-block-actions.ts
  // keepFrameAroundCode).
  await expect.poll(() => reply(page).locator('.md-code').evaluateAll((fs) => fs.every((f) => f.querySelector('pre')!.getBoundingClientRect().bottom - f.getBoundingClientRect().bottom <= 0.5)), { timeout: 3000 }).toBe(true);
  const first = block(page, 0);
  await expect.poll(() => first.evaluate((f) => { const p = f.querySelector('pre')!; return p.scrollWidth > p.clientWidth + 1; })).toBe(true);
  // The code line just under the header, by its number in the block.
  const lineUnderHead = () => first.evaluate((f) => {
    const head = f.querySelector('.md-code-head')!.getBoundingClientRect();
    const code = f.querySelector('pre code')!;
    const x = code.getBoundingClientRect().left + 4;
    const y = head.bottom + 14;
    const doc = document as any;
    const range: Range | null = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(x, y) : null;
    if (!range) return -1;
    const before = document.createRange();
    before.setStart(code, 0);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().split('\n').length - 1;
  });
  const stuck = await first.evaluate(async (f) => {
    const scroller = f.closest('.session-history') as HTMLElement;
    const glass = document.querySelector('.session-panel-header')?.getBoundingClientRect();
    const top = Math.max(glass?.bottom ?? 0, scroller.getBoundingClientRect().top);
    // Its top well above the visible top: the header rides mid-block.
    scroller.scrollTop += f.getBoundingClientRect().top - top + 90;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return f.querySelector('.md-code-head')!.getBoundingClientRect().top > f.getBoundingClientRect().top + 2;
  });
  expect(stuck).toBe(true);
  const lineBefore = await lineUnderHead();
  expect(lineBefore).toBeGreaterThan(0);
  // No observer loop: a toggle's size changes are never made inside one.
  await page.evaluate(() => {
    (window as any).__roErrors = [];
    window.addEventListener('error', (e) => { if (/ResizeObserver/.test(e.message)) (window as any).__roErrors.push(e.message); });
  });
  const wrap = first.locator('[data-md-code-action="wrap"]');
  const tops = () => first.evaluate((f) => [...f.querySelectorAll('.md-code-ln')].map((l) => l.getBoundingClientRect().top));
  await wrap.click();
  await expect(wrap).toHaveAttribute('aria-pressed', 'true');
  expect(Math.abs((await lineUnderHead()) - lineBefore)).toBeLessThanOrEqual(1);
  // Wrapped, the rows keep the unwrapped spacing: each line takes a whole
  // number of rows, and at least one long line takes more than one.
  const wrappedTops = await tops();
  const gaps = wrappedTops.slice(1).map((t, i) => t - wrappedTops[i]!);
  // One row: the shortest line (an engine may round the line height).
  const pitch = Math.min(...gaps);
  const spans = gaps.map((g) => g / pitch);
  for (const r of spans) expect(Math.abs(r - Math.round(r)), JSON.stringify({ pitch, spans })).toBeLessThan(0.06);
  expect(Math.max(...spans)).toBeGreaterThan(1.9);
  await wrap.click();
  await expect(wrap).toHaveAttribute('aria-pressed', 'false');
  expect(Math.abs((await lineUnderHead()) - lineBefore)).toBeLessThanOrEqual(1);
  for (let i = 0; i < 4; i++) await wrap.click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__roErrors)).toEqual([]);
  // Nor while the window is dragged narrower and wider through every width
  // where a block goes from fitting to scrolling; once it settles, each
  // block offers Wrap exactly when a line is cut off.
  const size = page.viewportSize()!;
  test.info().setTimeout(test.info().timeout + 90_000);
  for (let w = 760; w >= 380; w -= 5) await page.setViewportSize({ width: w, height: size.height });
  for (let w = 380; w <= 760; w += 19) await page.setViewportSize({ width: w, height: size.height });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__roErrors)).toEqual([]);
  const offers = await reply(page).locator('.md-code:not([data-wrap]):not([data-empty])').evaluateAll((fs) => fs.map((f) => {
    const pre = f.querySelector('pre')!;
    const btn = f.querySelector('[data-md-code-action="wrap"]') as HTMLElement;
    return [pre.scrollWidth > pre.clientWidth, btn.offsetParent !== null];
  }));
  for (const [cut, shown] of offers) expect(shown).toBe(cut);
  await page.setViewportSize(size);
}

async function injectDelta(page: Page, delta: string) {
  await page.evaluate(({ delta, sid, tid, mid }) => {
    const ws = (window as any).__capturedWs as WebSocket;
    const frame = JSON.stringify({ type: 'event', name: 'session:text-delta', data: { sessionId: sid, taskId: tid, msgId: mid, delta }, seq: Date.now() });
    ws.dispatchEvent(new MessageEvent('message', { data: frame }));
  }, { delta, sid: SESSION_ID, tid: TASK_ID, mid: MSG_ID });
}

export async function expectStreamingBlock(page: Page, engine: string) {
  await openSession(page);
  // Watch frame gaps for the whole stream.
  await page.evaluate(() => {
    const w = window as any;
    w.__maxGap = 0;
    let last = performance.now();
    const tick = (t: number) => {
      w.__maxGap = Math.max(w.__maxGap, t - last);
      last = t;
      if (!w.__stopFrames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const line = (i: number) => `export function step${i}(n: number): string { return \`step ${i}: \${n * ${i}}\`; } // ${'x'.repeat(i % 40)}\n`;
  let code = '';
  for (let i = 0; i < 300; i++) code += line(i);
  const text = 'Generating the module:\n\n```ts\n' + code;
  const firstHalf = text.slice(0, Math.floor(text.length / 2));
  for (let i = 0; i < firstHalf.length; i += 120) await injectDelta(page, firstHalf.slice(i, i + 120));

  const live = page.locator('.session-history .md-code').last();
  await expect(live.locator('.md-code-lang')).toHaveText('TypeScript', { timeout: 10_000 });
  await expect(live.locator('.token.keyword').first()).toBeVisible();
  // Copy mid-stream: what has arrived so far, as code.
  await live.locator('[data-md-code-action="copy"]').click();
  const copiedMid = await page.evaluate(() => (window as any).__copied.at(-1) as string);
  expect(copiedMid.startsWith('export function step0(')).toBe(true);
  expect(code.startsWith(copiedMid)).toBe(true);
  // Wrap mid-stream applies to the growing block and stays through later deltas.
  await live.locator('[data-md-code-action="wrap"]').click();

  const rest = text.slice(firstHalf.length) + '```\n\nAll 300 steps written.';
  for (let i = 0; i < rest.length; i += 120) await injectDelta(page, rest.slice(i, i + 120));
  await expect(page.locator('.session-history').getByText('All 300 steps written.')).toBeVisible({ timeout: 15_000 });
  // Frames are measured over the stream only: the scroll and screenshots below
  // pause rendering on their own.
  const maxGap = await page.evaluate(() => { (window as any).__stopFrames = true; return (window as any).__maxGap as number; });
  console.log(`[code-block] ${engine} max frame gap while streaming ${Math.round(maxGap)}ms`);
  // A frame gap this long is a visible stall; the 150ms flush plus a render of
  // ~25KB of code stays well under it in Chromium (~170ms). Headless WebKit on a
  // shared Linux box is several times slower for the app as a whole: the same
  // stream with plain code blocks measured 297 to 1203ms there (2026-11-04), so
  // its bound only catches a blowup, not the last 100ms. A wall-clock bound
  // measures the machine as much as the code, and a shared CI runner failed the
  // Chromium one (2026-11-08), so CI only logs it; the behavior above (label,
  // colors, Copy and Wrap mid-stream) is what CI asserts.
  if (!process.env.CI) expect(maxGap).toBeLessThan(engine === 'webkit' ? 1500 : 400);
  const done = page.locator('.session-history .md-code').last();
  await expect(done.locator('.token.keyword').first()).toBeVisible();
  // Watched as it streamed in: it stays open when its fence closes.
  expect(await done.evaluate((f) => f.hasAttribute('data-long') && !f.hasAttribute('data-collapsed'))).toBe(true);
  // The wrap set mid-stream held through every rebuild of the block.
  await expect(done).toHaveAttribute('data-wrap', '');
  await expect(done.locator('[data-md-code-action="wrap"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await done.locator('pre code').evaluate((c) => c.textContent)).toBe(code);
  expect(await done.evaluate((f) => {
    const pre = f.querySelector('pre')!;
    return pre.scrollWidth > pre.clientWidth + 1;
  })).toBe(false);
  // The header sticks: scrolled to the middle of the 300-line block, Copy is
  // still on screen and still copies the whole block.
  await done.evaluate((f) => {
    const scroller = (() => {
      for (let el = f.parentElement; el; el = el.parentElement) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      }
      return document.scrollingElement as HTMLElement;
    })();
    const top = f.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += top + f.getBoundingClientRect().height / 2;
  });
  await page.waitForTimeout(300);
  const stuck = await done.evaluate((f) => {
    const head = f.querySelector('.md-code-head')!.getBoundingClientRect();
    const frame = f.getBoundingClientRect();
    // Where the timeline's visible area starts: under the header glass when
    // the glass overlays the scroller, else the scroller's own top (a banner
    // or a tab bar in flow above it).
    const visibleTop = (sc: Element) => {
      const glass = document.querySelector('.session-panel-header')?.getBoundingClientRect();
      const top = sc.getBoundingClientRect().top;
      return glass && glass.bottom > top ? glass.bottom : top;
    };
    const scroller = f.closest('.session-history')!;
    const cover = parseFloat(getComputedStyle(f.querySelector('.md-code-head')!, '::before').height) || 0;
    return { headTop: head.top, frameTop: frame.top, top: visibleTop(scroller), cover, inView: head.top >= 0 && head.bottom <= window.innerHeight };
  });
  expect(stuck.frameTop).toBeLessThan(stuck.headTop);
  expect(stuck.inView).toBe(true);
  // At the top of the visible area: never under the glass, and any strip of
  // the scroller's padding above it is under the header's cover.
  expect(stuck.headTop).toBeGreaterThanOrEqual(stuck.top - 0.5);
  expect(stuck.headTop - stuck.top).toBeLessThan(5);
  expect(stuck.cover).toBeGreaterThanOrEqual(stuck.headTop - stuck.top);
  await shot(page, 'sticky-header', engine);
  await done.locator('[data-md-code-action="copy"]').click();
  expect(await page.evaluate(() => (window as any).__copied.at(-1))).toBe(code.replace(/\n$/, ''));

  await shot(page, 'streamed-wrapped', engine);
}

/** Scroll the timeline by the wheel, as a reader does, until `offset` px of
 *  `target` lie above the timeline's top (negative: that far below it). A
 *  scroll the page sets itself is undone while the session still follows its
 *  latest message. */
async function wheelTo(page: Page, target: Locator, offset: number) {
  const box = (await page.locator('.session-history').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // In place three times in a row: right after a load the session may still pull
  // itself back to its latest message once.
  // Bounded by time, not by tries: under load the pull back can come late.
  const until = Date.now() + 20_000;
  let settled = 0;
  while (settled < 3) {
    if (Date.now() > until) throw new Error(`wheelTo: could not bring the block to ${offset}px`);
    const dy = await target.evaluate((f, off) => f.getBoundingClientRect().top - f.closest('.session-history')!.getBoundingClientRect().top + off, offset);
    // Within a few px: a wheel step in WebKit can land a little off.
    if (Math.abs(dy) < 6) { settled++; await page.waitForTimeout(300); continue; }
    const from = await page.evaluate(() => document.querySelector('.session-history')!.scrollTop);
    await page.mouse.wheel(0, dy);
    // A wheel scroll animates: wait for it to come to rest before the next.
    let last = NaN;
    for (let t = 0; t < 20; t++) {
      await page.waitForTimeout(120);
      const now = await page.evaluate(() => document.querySelector('.session-history')!.scrollTop);
      if (now === last) break;
      last = now;
    }
    // At the timeline's end (or top) there is no further to go: as close as
    // it gets counts as in place.
    if (Math.abs(last - from) < 1) settled++;
    else settled = 0;
  }
}

export async function expectLongBlockFolds(page: Page) {
  // Two reloads and a scroll by the wheel: more than one page's worth of time.
  test.info().setTimeout(test.info().timeout + 90_000);
  await openSession(page);
  const long = page.locator('.session-history .session-msg-assistant').first().locator('.md-code').first();
  await wheelTo(page, long, -40);
  await expect(long).toHaveAttribute('data-collapsed', '');
  const more = long.locator('[data-md-code-action="expand"]');
  await expect(more).toHaveText('Show all 80 lines');
  await expect(more).toBeVisible();
  expect(await long.evaluate((f) => f.getBoundingClientRect().height)).toBeLessThan(620);
  // Folded or not, Copy takes the whole block.
  await long.locator('[data-md-code-action="copy"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied.at(-1))).toBe(LONG_CODE);
  // Centered first: scrolled only to the viewport's edge, the button sits under
  // the session's bottom bar.
  await more.evaluate((b) => b.scrollIntoView({ block: 'center' }));
  await more.click();
  await expect(long).not.toHaveAttribute('data-collapsed', '');
  await expect(more).toBeHidden();
  expect(await long.evaluate((f) => f.getBoundingClientRect().height)).toBeGreaterThan(1000);
  // Unfolded stays unfolded across a reload (this tab).
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(long).toBeVisible({ timeout: 15_000 });
  await expect(long).toHaveAttribute('data-long', '');
  await expect(long).not.toHaveAttribute('data-collapsed', '');
  // Folded again from deep inside it: Fold rides in the stuck header.
  const fold = long.locator('[data-md-code-action="fold"]');
  // 600px into it: the header rides the top, the block's end well below.
  await wheelTo(page, long, 600);
  const headTop = await long.locator('.md-code-head').evaluate((h) => h.getBoundingClientRect().top);
  expect(headTop).toBeGreaterThan(await long.evaluate((f) => f.getBoundingClientRect().top + 200));
  // On screen as the reader sees it: inside the timeline, not slid off with the block's end.
  expect(headTop).toBeGreaterThanOrEqual(await long.evaluate((f) => f.closest('.session-history')!.getBoundingClientRect().top - 10));
  await expect(fold).toBeVisible();
  await fold.click();
  await expect(long).toHaveAttribute('data-collapsed', '');
  await expect(fold).toBeHidden();
  // The header did not move on screen, now at the block's top (within the
  // stick offset); unless the page ran out of room above (this block opens
  // the conversation), where the block's top is simply in view.
  const after = await long.evaluate((f) => [
    f.querySelector('.md-code-head')!.getBoundingClientRect().top,
    f.getBoundingClientRect().top,
    (f.closest('.session-history') as HTMLElement).scrollTop,
  ]);
  if (after[2]! > 0) {
    expect(Math.abs(after[0]! - headTop)).toBeLessThanOrEqual(2);
    expect(Math.abs(after[1]! + 1 - headTop)).toBeLessThanOrEqual(8);
  } else {
    expect(after[1]!).toBeGreaterThanOrEqual(headTop - 8);
  }
  await expect(more).toBeFocused();
  // From the keyboard: unfolded, focus on the code shows its ring; then
  // folded again for the reload below.
  await page.keyboard.press('Enter');
  await expect(long).not.toHaveAttribute('data-collapsed', '');
  await expect.poll(() => long.evaluate((f) => getComputedStyle(f).outlineStyle)).toBe('solid');
  await long.locator('[data-md-code-action="fold"]').click();
  await expect(long).toHaveAttribute('data-collapsed', '');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(long).toBeVisible({ timeout: 15_000 });
  await expect(long).toHaveAttribute('data-collapsed', '');
  // A diff's tinted rows reach the far end of its widest line, scrolled or not.
  const diff = page.locator('.session-history .session-msg-assistant').first().locator('.md-code').nth(1);
  await page.setViewportSize({ width: 390, height: page.viewportSize()!.height });
  const rows = await diff.evaluate((f) => {
    const code = f.querySelector('code')!;
    const pre = f.querySelector('pre')!;
    return {
      code: code.getBoundingClientRect().width,
      scrolls: pre.scrollWidth > pre.clientWidth,
      rows: [...f.querySelectorAll('.md-code-ln-add, .md-code-ln-del')].map((r) => r.getBoundingClientRect().width),
    };
  });
  expect(rows.scrolls).toBe(true);
  expect(rows.rows.length).toBe(2);
  for (const w of rows.rows) expect(Math.abs(w - rows.code)).toBeLessThan(1);
  // At this width the long block scrolls sideways. Open, its scrollbar stays
  // at the timeline's foot (where the engine draws one) and scrolls the code.
  // Opened from the keyboard: at this width the session's own overlays (the
  // Latest button) may sit over the button.
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(long).not.toHaveAttribute('data-collapsed', '');
  const rail = long.locator('.md-code-rail');
  await expect(rail).toHaveCSS('display', 'block');
  // Inside the block, its end well below the timeline's foot.
  await wheelTo(page, long, 300);
  // Both ways, and to the end: the rail's range is the code's.
  const pre = long.locator('pre');
  const range = await pre.evaluate((e) => e.scrollWidth - e.clientWidth);
  expect(range).toBeGreaterThan(20);
  expect(Math.abs((await rail.evaluate((r) => r.scrollWidth - r.clientWidth)) - range)).toBeLessThanOrEqual(1);
  const mid = Math.floor(range / 2);
  await rail.evaluate((r, x) => { r.scrollLeft = x; }, mid);
  await expect.poll(() => pre.evaluate((e) => Math.round(e.scrollLeft))).toBe(mid);
  await rail.evaluate((r) => { r.scrollLeft = r.scrollWidth; });
  await expect.poll(async () => Math.abs((await pre.evaluate((e) => e.scrollLeft)) - range)).toBeLessThanOrEqual(1);
  await pre.evaluate((e) => { e.scrollLeft = 0; });
  await expect.poll(() => rail.evaluate((r) => Math.round(r.scrollLeft))).toBe(0);
  const foot = await rail.evaluate((r) => {
    const b = r.getBoundingClientRect();
    return { h: b.height, bottom: b.bottom, timeline: r.closest('.session-history')!.getBoundingClientRect().bottom };
  });
  if (foot.h > 0) expect(Math.abs(foot.bottom - foot.timeline)).toBeLessThan(2);
}

export async function expectDarkThemeReadable(page: Page, engine: string) {
  await openSession(page, { theme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  await shot(page, 'framed-dark', engine);
}
