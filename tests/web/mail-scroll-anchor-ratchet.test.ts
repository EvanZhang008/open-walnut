/**
 * Mail's scroll boxes and WebKit's missing scroll anchoring (2026-11-01).
 *
 * Chromium keeps the row a person is reading in place when something lands above it (CSS scroll
 * anchoring); WebKit, which the Mac app runs, does not. The mail sidebar relied on the native one,
 * so the smart group arriving above a scrolled pane held its rows in Chromium and threw them 132px
 * in WebKit alone, and only the WebKit run of `mail-app-sidebar.spec.ts` saw it.
 *
 * Two layers:
 *  - `anchoredScrollTop`, the arithmetic `useScrollAnchor` corrects by, including the two moves that
 *    must never be corrected: the person's own scroll and the browser's clamp at the end of the list.
 *  - every vertical scroll box in Mail's CSS has a verdict. A box anchored by hand turns the native
 *    anchoring off (two corrections of one move would double it in Chromium) and its component calls
 *    the hook; any other box says why nothing lands above what a person reads in it. A NEW scroll box
 *    fails here until somebody decides which one it is.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { anchorDrift, anchoredScrollTop } from '@/hooks/scroll-anchor';

const MAIL_DIR = path.resolve(__dirname, '../../web/src/apps/mail');

type Verdict =
  | { anchored: string }
  | { static: string };

/** Keyed by the rule's selector. `anchored` names the component that calls `useScrollAnchor`. */
const SCROLL_BOXES: Record<string, Verdict> = {
  '.mail-accounts-scroll': { anchored: 'MailAccountsPane.tsx' },
  '.mail-rows': {
    static: 'measured 2026-11-01 in both engines: an arrival replaces the flat page or lands without '
      + 'moving the row being read in the grouped list, and a group opens below the line clicked',
  },
  '.mail-compose-scroll': { static: 'a form being typed in: what grows is the field under the caret' },
  '.mail-compose-quote': { static: 'the quoted original, fixed text once the composer opens' },
  '.mail-send-status': { static: 'one send\'s status lines, written in place' },
  '.mail-correct': { static: 'a popover over one message, drawn whole' },
  '.mail-unsub-list': { static: 'the plan dialog\'s rows, each updated in place' },
  '.mail-add-dialog': { static: 'a modal form, nothing arrives in it from outside' },
  '.mail-setup-options': { static: 'a fixed set of preset chips' },
  '.mail-reader-detail-rows': { static: 'one message\'s recipients, fixed once it opens' },
  '.mail-attachments': { static: 'one message\'s attachments, fixed once it opens' },
  '.mail-body-text': { static: 'one message\'s plain text body, fixed once it opens' },
};

interface Rule { file: string; selector: string; body: string }

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  ));
}

/** Whether a rule's declarations let it scroll vertically: `overflow-y`, or `overflow`'s one value or its second. */
function scrollsVertically(body: string): boolean {
  for (const match of body.matchAll(/(?:^|[;{\s])overflow(-y)?\s*:\s*([^;]+)/g)) {
    const values = match[2]!.trim().split(/\s+/);
    const y = match[1] ? values[0] : values[values.length - 1];
    if (y === 'auto' || y === 'scroll') return true;
  }
  return false;
}

/** Every rule of Mail's CSS that scrolls vertically. Comments go first: they quote declarations. */
function scrollRules(): Rule[] {
  const rules: Rule[] = [];
  for (const file of walk(MAIL_DIR).filter((one) => one.endsWith('.css'))) {
    const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = match[2]!;
      if (!scrollsVertically(body)) continue;
      rules.push({ file: path.relative(MAIL_DIR, file), selector: match[1]!.trim().replace(/\s+/g, ' '), body });
    }
  }
  return rules;
}

/** A list 2,000px long in a 600px box: the end is 1,400 until the content changes. */
const LONG = 1_400;

describe('anchoredScrollTop', () => {
  it('scrolls by the height of a block landing above the row', () => {
    expect(anchoredScrollTop({ top: 40, scrollTop: 300 }, 172, 300, LONG + 132)).toBe(432);
  });

  it('leaves the box alone when nothing moved, and for subpixel layout', () => {
    expect(anchoredScrollTop({ top: 40, scrollTop: 300 }, 40, 300, LONG)).toBe(300);
    expect(anchoredScrollTop({ top: 40, scrollTop: 300 }, 40.3, 300, LONG)).toBe(300);
  });

  it('never reads the person\'s own scroll as a move', () => {
    // A wheel moved the box 120px before its scroll event was dispatched, and a render came first.
    expect(anchorDrift({ top: 40, scrollTop: 300 }, -80, 420)).toBe(0);
    expect(anchoredScrollTop({ top: 40, scrollTop: 300 }, -80, 420, LONG)).toBe(420);
  });

  it('keeps the person\'s scroll AND undoes a block landing in the same frame', () => {
    expect(anchoredScrollTop({ top: 40, scrollTop: 300 }, 52, 420, LONG + 132)).toBe(552);
  });

  it('a block landing above while the box sits at its end moves the end with it', () => {
    expect(anchoredScrollTop({ top: 40, scrollTop: LONG }, 172, LONG, LONG + 132)).toBe(LONG + 132);
  });

  it('never undoes the clamp after the content BELOW got shorter', () => {
    // The tail collapsed below the view: the browser pulled the box up by 200, every row moved down with it.
    expect(anchoredScrollTop({ top: 40, scrollTop: LONG }, 240, LONG - 200, LONG - 200)).toBe(LONG - 200);
  });

  it('never counts the clamp twice when a row ABOVE the view left at the end of the list', () => {
    // A 28px row above the view went away: the browser's pull of 28px already holds every row in place.
    // Adding the content move on top of the pulled position threw the rows 28px down.
    expect(anchoredScrollTop({ top: 40, scrollTop: LONG }, 40, LONG - 28, LONG - 28)).toBe(LONG - 28);
  });

  it('finishes the job when a row above left and the clamp pulled only part of it', () => {
    // 50px from the end, a 100px row above left: the box was pulled to the new end, 50px short.
    expect(anchoredScrollTop({ top: 40, scrollTop: LONG - 50 }, -10, LONG - 100, LONG - 100)).toBe(LONG - 150);
  });
});

describe('every Mail scroll box has a verdict on WebKit scroll anchoring', () => {
  const rules = scrollRules();

  it('finds the boxes (a parser that finds none proves nothing)', () => {
    expect(rules.map((one) => one.selector)).toContain('.mail-accounts-scroll');
  });

  it('lists every scroll box, and lists none that no longer exists', () => {
    const found = [...new Set(rules.map((one) => one.selector))].sort();
    const unknown = found.filter((one) => !(one in SCROLL_BOXES));
    expect(unknown, 'a new scroll box in Mail: if anything can land above what a person reads in it, '
      + 'anchor it with useScrollAnchor and `overflow-anchor: none`; otherwise add it with the reason').toEqual([]);
    expect(Object.keys(SCROLL_BOXES).filter((one) => !found.includes(one)).sort(), 'stale entries').toEqual([]);
  });

  it('an anchored box turns the native anchoring off and its component calls the hook', () => {
    for (const [selector, verdict] of Object.entries(SCROLL_BOXES)) {
      if (!('anchored' in verdict)) continue;
      for (const rule of rules.filter((one) => one.selector === selector)) {
        expect(/overflow-anchor\s*:\s*none/.test(rule.body), `${selector} in ${rule.file}`).toBe(true);
      }
      const source = fs.readFileSync(path.join(MAIL_DIR, verdict.anchored), 'utf8');
      expect(source, verdict.anchored).toMatch(/useScrollAnchor\(/);
      expect(source, `${verdict.anchored} renders ${selector} with the anchored ref`)
        .toMatch(new RegExp(`className="${selector.slice(1)}"\\s+ref=`));
    }
  });

  it('a box nobody anchors keeps the native one, so Chromium is not made worse', () => {
    for (const rule of rules) {
      const verdict = SCROLL_BOXES[rule.selector];
      if (!verdict || 'anchored' in verdict) continue;
      expect(/overflow-anchor\s*:\s*none/.test(rule.body), `${rule.selector} in ${rule.file}`).toBe(false);
    }
  });
});
