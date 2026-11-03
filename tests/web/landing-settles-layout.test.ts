/**
 * A stack landing is exact only against the layout the reader will see (C4).
 *
 * 2026-11-03: in the full-screen sheet, Esc from a question back to the root
 * closed the split's left half in the same commit, so the history box went from
 * half to full width. The question map's gutter follows the box's width through
 * state a ResizeObserver feeds one render late, so the pop landed the passage
 * under the half-width gutter (176px), then the full-width one (320px) rewrapped
 * every row and the passage sat 22px lower than where it was asked
 * (tests/e2e/browser/session-thread-fixes-r3.spec.ts, "landing drift for Q6").
 *
 * The class: anything on the history box whose layout follows the box's width a
 * render late. Each one must settle before a landing measures (settleLayout), or
 * be named here with why it can never move a landing. A new attribute or style
 * on the box fails this file until it is classified.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SCH = read('web/src/components/sessions/SessionChatHistory.tsx');
const LANDING = read('web/src/hooks/useThreadLanding.ts');
const MAP = read('web/src/hooks/useThreadMapLayout.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** The props of the `<div className="session-history" ...>` opening tag. */
function historyBoxTag(src: string): string {
  const at = src.indexOf('className="session-history"');
  expect(at, 'the history box is in SessionChatHistory').toBeGreaterThan(0);
  const open = src.lastIndexOf('<div', at);
  // The tag ends at the first `>` that closes it at brace depth 0.
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(open, i + 1);
  }
  throw new Error('unterminated history box tag');
}

/**
 * What the box carries, and how each stays out of a landing's way. `settled`:
 * the landing calls its settle first. Any other value says why it cannot move
 * a landing.
 */
const BOX_LAYOUT: Record<string, string> = {
  'className': 'static',
  'ref': 'not layout',
  'onClick': 'not layout',
  'data-view-mode': 'follows the mode, not the width; a mode switch lands its own scroll',
  'data-thread-map': 'settled',
  '--thread-map-w': 'settled',
  'data-review-sidebar': 'Conversation Mode only, where useThreadLanding is targetOnly and never lands',
  'display': 'a team tab hides the box; a hidden box has nothing to land',
};

describe('a stack landing measures against the final layout', () => {
  it('every prop on the history box is classified', () => {
    const tag = historyBoxTag(SCH);
    const names = new Set<string>();
    for (const m of tag.matchAll(/\s([a-zA-Z][\w-]*)=\{/g)) names.add(m[1]);
    for (const m of tag.matchAll(/\s([a-zA-Z][\w-]*)="/g)) names.add(m[1]);
    for (const m of tag.matchAll(/'((?:data-|--)[\w-]+)'/g)) names.add(m[1]);
    for (const m of tag.matchAll(/\{\s*(display):/g)) names.add(m[1]);
    names.delete('style');
    const unknown = [...names].filter((n) => !(n in BOX_LAYOUT));
    expect(unknown, 'new history box props: settle them before a landing (settleLayout) or say here why they cannot move one').toEqual([]);
  });

  it('the map gutter, the width-following part, offers a settle that writes the gutter and records it', () => {
    expect(MAP).toMatch(/const settle = useCallback\(/);
    const body = MAP.slice(MAP.indexOf('const settle = useCallback('));
    expect(body).toMatch(/el\.offsetWidth/);
    expect(body).toMatch(/applyGutter\(el, nextShape, nextWidth\)/);
    // Recorded as what the DOM holds, so the re-render's hold sees no move.
    expect(body).toMatch(/last\.current = \{ shape: nextShape, width: nextWidth, measured: true \}/);
    expect(body).toMatch(/setWidth\(w\)/);
  });

  it('every timeline that lands passes the settle', () => {
    const calls = walk(join(ROOT, 'web/src'))
      .filter((p) => !p.endsWith('useThreadLanding.ts'))
      .flatMap((p) => {
        const src = readFileSync(p, 'utf8');
        return [...src.matchAll(/useThreadLanding\(\{([\s\S]*?)\}\);/g)].map((m) => ({ file: relative(ROOT, p), args: m[1] }));
      });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.args, `${c.file} passes settleLayout`).toMatch(/settleLayout:/);
  });

  it('the navigation effect settles before its first landing write', () => {
    const start = LANDING.indexOf('useLayoutEffect(() => {\n    const nav = stack.nav;');
    expect(start, 'the navigation layout effect').toBeGreaterThan(0);
    const body = LANDING.slice(start, LANDING.indexOf('}, [stack.nav?.seq', start));
    expect(body, 'the effect settles through settleLayout').toMatch(/const settle = \(\) => argsRef\.current\.settleLayout\?\.\(\);/);
    // Only a path that lands settles: the restore branch once it has a record, the
    // navigation branch before its first write. A path that returns leaves a gutter
    // change to the map's own hold.
    const restore = body.indexOf('if (!rec) return;\n      settle();');
    const navigate = body.indexOf('return holdScroll(el, rec.scrollTop);\n    }\n    settle();');
    expect(restore, 'the restore branch settles right after it finds its record').toBeGreaterThan(0);
    expect(navigate, 'the navigation branch settles before it writes').toBeGreaterThan(restore);
    const navStart = navigate + 'return holdScroll(el, rec.scrollTop);\n    }\n    settle();'.length;
    for (const write of ['el.scrollTop =', 'landPop(', 'slide(', 'holdScroll(']) {
      const first = body.indexOf(write);
      expect(first, `${write} is in the effect`).toBeGreaterThan(0);
      // Every write is after one of the two settles, and none sits between them
      // outside the restore branch.
      for (let at = first; at >= 0; at = body.indexOf(write, at + 1)) {
        expect(at > restore, `${write} at ${at} comes after a settle`).toBe(true);
      }
    }
    expect(body.slice(navStart)).toMatch(/slide\(|landPop\(/);
  });
});
