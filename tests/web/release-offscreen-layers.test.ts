/**
 * WebKit keeps old layer surfaces for rows that scroll away while replies stream into a session
 * history (graphics-leak round 4, 2026-11-26: 19 surfaces, 60 MB after 12 replies in one column;
 * a column Evan keeps open all day held about 1 GB). release-offscreen-layers.ts drops them after
 * each reply. Every element rendered as a session history (the `session-history` scroller) either
 * runs that hook or is listed below as one replies never stream into.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { rowsToRelease } from '../../web/src/components/sessions/release-offscreen-layers';
import { isMacDesktopWebKit, isWebKitEngine } from '../../web/src/utils/webkit-engine';

// The view: top edge at 100 (a 1200x800 window's session column).
const VIEW_TOP = 100;
const row = (top: number, height: number) => ({ top, bottom: top + height, height });

describe('rowsToRelease', () => {
  it('takes only rows wholly above the view by more than the margin', () => {
    const rows = [row(-1500, 1300), row(-250, 300), row(60, 400), row(460, 300)];
    // The second ends 50 above the view (inside the 200px margin); the last two are on screen.
    expect(rowsToRelease(rows, VIEW_TOP)).toEqual([0]);
  });

  it('never takes a row with no box of its own (display:contents, a zero-height card layer)', () => {
    // A history scrolled 300px down: a box-less row reads all zeros, which is "above" the view.
    expect(rowsToRelease([{ top: 0, bottom: 0, height: 0 }, row(-900, 400)], 400)).toEqual([1]);
    expect(rowsToRelease([row(-2000, 0)], VIEW_TOP)).toEqual([]);
  });

  it('takes the rows nearest the view first, at most the limit, with no reach cap', () => {
    const rows = [row(-90000, 1000), row(-8000, 1300), row(-2400, 1300), row(-900, 26), row(-870, 700)];
    expect(rowsToRelease(rows, VIEW_TOP)).toEqual([0, 1, 2, 3, 4]);
    expect(rowsToRelease(rows, VIEW_TOP, 2)).toEqual([3, 4]);
  });

  it('takes nothing when every row is on screen', () => {
    expect(rowsToRelease([row(110, 200), row(320, 300)], VIEW_TOP)).toEqual([]);
  });
});

const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

describe('isWebKitEngine', () => {
  it('is WebKit itself, not a Chromium that names AppleWebKit', () => {
    expect(isWebKitEngine(SAFARI_MAC)).toBe(true);
    expect(isWebKitEngine(CHROME_MAC)).toBe(false);
    expect(isWebKitEngine('')).toBe(false);
  });
});

describe('isMacDesktopWebKit', () => {
  it('is the Mac app or Safari on a Mac, not an iPhone or an iPad', () => {
    expect(isMacDesktopWebKit(SAFARI_MAC, 0)).toBe(true);
    expect(isMacDesktopWebKit(SAFARI_MAC, 5)).toBe(false); // an iPad names Macintosh too
    expect(isMacDesktopWebKit(IPHONE, 5)).toBe(false);
    expect(isMacDesktopWebKit(CHROME_MAC, 0)).toBe(false);
  });
});

const WEB_SRC = path.join(__dirname, '../../web/src');
/** Session histories replies never stream into, and why. */
const NO_STREAM = new Map<string, string>([
  ['components/notes/NotesSessionChat.tsx', 'the shell shown before the note chat starts its session: queued user messages only, no reply streams into it'],
]);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(full));
    else if (e.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('every streaming session history drops its old layer surfaces', () => {
  const rendering = tsxFiles(WEB_SRC)
    .map((f) => ({ rel: path.relative(WEB_SRC, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }))
    .filter(({ text }) => /className=\{?[`'"]session-history(?![\w-])/.test(text));

  it('finds the histories (the scan works)', () => {
    expect(rendering.map((r) => r.rel)).toContain('components/sessions/SessionChatHistory.tsx');
  });

  it('each runs useReleaseOffscreenLayers or is listed as one replies never stream into', () => {
    const missing = rendering.filter(({ rel, text }) => !NO_STREAM.has(rel) && !/useReleaseOffscreenLayers\(/.test(text)).map((r) => r.rel);
    expect(missing).toEqual([]);
  });

  it('lists no history that is gone', () => {
    const seen = new Set(rendering.map((r) => r.rel));
    expect([...NO_STREAM.keys()].filter((k) => !seen.has(k))).toEqual([]);
  });
});
