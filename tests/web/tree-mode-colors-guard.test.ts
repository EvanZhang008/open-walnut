/**
 * Tree Mode paints with the same few colours as Conversation Mode (2026-11-10,
 * the user: "in tree model every line color is different not necessary keep it
 * simple few standard color like conversation model"). It used to give every
 * branch its own hue: the passage marks, the sliver bars beside a page, the
 * quote head, the status dots, the question list rows.
 *
 * Now a passage mark is painted by its question's state (waiting, answering,
 * unread, failed, read, resolved: thread-mark-state.ts) in both views, every
 * other branch colour is the theme's muted grey, and the page being worked on
 * wears the accent. This guard fails when:
 *  - a Tree Mode mark spec is not a neutral (state) mark;
 *  - any stylesheet reads a branch hue again (`--thread-hue`, `--live-hue`), or a
 *    Tree Mode stylesheet writes a colour literal outside the standard set
 *    (theme tokens, plus the state colours of the marks' live and wait lines).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { markSpecsFor } from '@/utils/thread-stack-state';
import { withMarkStates } from '@/utils/thread-card';
import { markHighlightName } from '@/hooks/useThreadMarks';
import { ROOT_THREAD_KEY, type ThreadNode, type ThreadTree } from '@/utils/thread-tree';
import type { ThreadMetaIndex } from '@/utils/thread-meta';
import type { ThreadMarkState } from '@/utils/thread-mark-state';

const WEB = path.resolve(__dirname, '../../web/src');
const STYLES = path.join(WEB, 'styles');

function node(key: string, depth: number, hue: number, parent: string | undefined, childKeys: string[]): ThreadNode {
  return {
    key, depth, hue, headId: `h-${key}`, parent, childKeys,
    quote: parent ? { exact: `passage of ${key}` } : undefined,
  } as unknown as ThreadNode;
}

/** Main with three questions of three different branch hues, one with a follow-up. */
function tree(): ThreadTree {
  const nodes = [
    node(ROOT_THREAD_KEY, 0, 0, undefined, ['a', 'b', 'c']),
    node('a', 1, 280, 'm1', ['a1']),
    node('b', 1, 152, 'm2', []),
    node('c', 1, 28, 'm3', []),
    node('a1', 2, 280, 'm4', []),
  ];
  return { threads: nodes, byKey: new Map(nodes.map((n) => [n.key, n])), topCount: 3 } as unknown as ThreadTree;
}

const INDEX = new Map() as unknown as ThreadMetaIndex;

describe('Tree Mode marks are Conversation Mode marks', () => {
  it('every mark on a page is a neutral mark painted by its state, whatever its branch hue', () => {
    const t = tree();
    for (const currentKey of [ROOT_THREAD_KEY, 'a']) {
      const specs = markSpecsFor({ tree: t, currentKey, hiddenKeys: new Set(), index: INDEX });
      expect(specs.length).toBeGreaterThan(0);
      for (const s of specs) expect(s.neutral, s.key).toBe(true);
      const states = new Map<string, ThreadMarkState>(specs.map((s, i) => [s.key, (['waiting', 'unread', 'read'] as const)[i % 3]]));
      const names = new Set(withMarkStates(specs, states).map((s) => markHighlightName(s.hue, s.resolved, s.neutral, false, s.state)));
      // Three branches of three hues paint with state names only, no hue in any name.
      for (const n of names) expect(n, n).toMatch(/^thread-mark-(?:[a-z]+-)?neutral$/);
    }
  });
  it('the chat paints Tree Mode marks with their states, the same call as Conversation Mode', () => {
    const src = fs.readFileSync(path.join(WEB, 'components/sessions/SessionChatHistory.tsx'), 'utf8');
    // One withMarkStates over both views' specs: a Tree Mode mark without it paints as read only.
    expect(src).toMatch(/withMarkStates\(stackMode\s*\?\s*markSpecsFor\(/);
  });
});

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;

/** The Tree Mode stylesheets: the split, the stack page and its chrome and foundation. */
const TREE_SHEETS = ['tree-split.css', 'thread-stack.css', 'thread-stack-page.css', 'thread-stack-chrome.css'];

/**
 * Colour literals a Tree Mode sheet may write, each with why: the state colours
 * the marks share with Conversation Mode (the answering scan's green, the
 * waiting line's amber) and the depth guide lines' greys.
 */
const ALLOWED_LITERALS: ReadonlyArray<RegExp> = [
  /^hsl\(140 /, /^hsl\(145 /, // answering: the live scan (Conversation Mode's read/answering green)
  /^hsl\(38 /, /^hsl\(42 /, // waiting: the amber wait line
  /^rgba\(60, 60, 67, /, /^rgba\(235, 235, 245, /, // the drawer's depth guides (neutral greys)
  // Neutrals: white text on the accent, black shadows, white and black washes, the tooltip's near-black.
  /^#fff\b/i, /^#ffffff\b/i, /^#1d1d1f\b/i, /^rgba\(0, 0, 0, /, /^rgba\(255, 255, 255, /,
];

describe('no branch hue in any stylesheet', () => {
  it('no stylesheet reads a branch hue', () => {
    const offenders: string[] = [];
    for (const f of fs.readdirSync(STYLES).filter((x) => x.endsWith('.css'))) {
      const text = fs.readFileSync(path.join(STYLES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/var\(\s*--(?:thread|live)-hue\b/.test(text)) offenders.push(f);
    }
    expect(offenders, 'stylesheets that colour by branch hue').toEqual([]);
  });

  it('Tree Mode stylesheets write colours from the standard set only', () => {
    const offenders: string[] = [];
    for (const f of TREE_SHEETS) {
      const lines = fs.readFileSync(path.join(STYLES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(COLOR_LITERAL)) {
          const rest = line.slice(m.index);
          if (!ALLOWED_LITERALS.some((re) => re.test(rest))) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, 'colour literals outside the standard set (use a theme token, or list a new state colour with why)').toEqual([]);
  });
});
