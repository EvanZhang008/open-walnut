/**
 * One row, one key-hint footer, one open trigger for every menu (web/src/styles/overlay-family.css).
 *
 * 2026-11-23, the UI audit: 54 menus drew their one-line rows at eleven heights from 24 to 36 px; four
 * key-hint footers had four paddings, three type sizes and filled, outlined and bare keys; two menu
 * triggers stayed grey while their menu was open, where the others turn on. The user: "all of it
 * should be consistent".
 *
 *   1. Every row class of a hand-built `wn-menu` box is in the family's row list (one height,
 *      --overlay-row-height), or named below with why it is not one line of words.
 *   2. Every footer of key hints is `wn-menu-foot`, and every key cap in one is `wn-key`.
 *   3. Every button that opens a menu or popover (its ref is the anchor or trigger the surface is placed
 *      against) says so with aria-haspopup, so the button family draws it on while open.
 * The drawn height of the big menus' rows is checked in tests/e2e/browser/big-menu-shape.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanCss, walk } from './css-scan';

const WEB_SRC = path.join(__dirname, '../../web/src');
const FAMILY_CSS = fs.readFileSync(path.join(WEB_SRC, 'styles/overlay-family.css'), 'utf8');
const rel = (f: string) => path.relative(WEB_SRC, f).split(path.sep).join('/');
const tsx = walk(WEB_SRC, ['.tsx']);

/** The classes the family's row rule names (the `html :is(.wn-menu, .wn-overlay) :is(...)` list). */
function familyRows(): Set<string> {
  const m = FAMILY_CSS.match(/html :is\(\.wn-menu, \.wn-overlay\) :is\(([^)]*)\)/);
  if (!m) throw new Error('overlay-family.css has no row rule');
  return new Set([...m[1].matchAll(/\.([\w-]+)/g)].map((x) => x[1]));
}

/** Row classes of a menu box that are not one line of words, each with why. */
const NOT_A_ONE_LINE_ROW: Record<string, string> = {
  'adopt-worker-row': 'a task title over its project line: two lines by design',
  'session-control-option': "a mode's name over its description: two lines by design",
  'cal-form-row': "the event form's calendar field, a trigger inside a form, not a menu row",
  'tp-row-title': "a table row's title, not a menu row",
  'session-taskbar-open': "a key inside the taskbar's More row (.session-taskbar-more-row is the row)",
  'session-taskbar-close': "a key inside the taskbar's More row (.session-taskbar-more-row is the row)",
  'wn-context-menu-pill': 'a pill in a run of pills, the button family',
  'tag-pills-menu-row': 'a run of tag pills, the chip family',
  'badge': 'a badge that opens a menu, not a row in one',
};

/** A state class on a bare row of .notes-context-menu or .cal-ctx-menu, whose rows the rule names as `> button`. */
const BARE_ROW_MODIFIERS = new Set(['danger', 'cal-ctx-danger']);

const ROLE = /role=["'{](?:`|")?(menuitem\w*|option)/;
const TAG = /<(button|a|div|li)\b(?:[^>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*?>/g;

function staticClasses(tag: string): string[] {
  const m = tag.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
  if (!m) return [];
  return (m[1] ?? m[2]).split('${')[0].split(/\s+/).filter(Boolean);
}

describe('one row height for every menu', () => {
  it('every row class of a menu box is a family row, or named with why not', () => {
    const rows = familyRows();
    const off: string[] = [];
    for (const f of tsx) {
      const src = fs.readFileSync(f, 'utf8');
      if (!/className=\{?[`"'][^`"']*\bwn-menu(?![\w-])/.test(src)) continue;
      for (const m of src.matchAll(TAG)) {
        const tag = m[0];
        const classes = staticClasses(tag);
        const rowish = ROLE.test(tag) || (m[1] === 'button' && classes.some((c) => /(?:^|-)(item|row|opt|option)$/.test(c)));
        // A bare <button> is a row of .notes-context-menu or .cal-ctx-menu, which the rule names.
        if (!rowish || !classes.length) continue;
        if (classes.some((c) => rows.has(c) || c in NOT_A_ONE_LINE_ROW || BARE_ROW_MODIFIERS.has(c))) continue;
        off.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length} .${classes[0]}`);
      }
    }
    expect(off, 'add the row class to the row rule in overlay-family.css, or name it in NOT_A_ONE_LINE_ROW with why').toEqual([]);
  });

  it('the exceptions are still in the source', () => {
    const all = tsx.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    for (const c of Object.keys(NOT_A_ONE_LINE_ROW)) expect(all, c).toMatch(new RegExp(`\\b${c}\\b`));
  });

  it('a row of the family is 30 px: 6 px above and below an 18 px line', () => {
    expect(FAMILY_CSS).toMatch(/--overlay-row-height: 30px;/);
    expect(FAMILY_CSS).toMatch(/--overlay-row-pad-y: 6px;/);
    // Its words are one size in every menu, and on a phone every row is finger-sized.
    expect(FAMILY_CSS).toMatch(/--overlay-row-font: var\(--font-size-sm\);/);
    expect(FAMILY_CSS).toMatch(/font-size: var\(--overlay-row-font\);/);
    expect(FAMILY_CSS).toMatch(/@media \(max-width: 768px\)[^{]*\{\s*:root \{ --overlay-row-height: 44px; \}/);
  });

  // 2026-11-26, the UI audit at 390 wide: the phone's stylesheet gave the ⋮ menus' rows 44 px and
  // their chips 14 px words, so those menus' rows were 44 px and every other menu's 30 px. A phone's
  // row height comes from the family's one variable, so no phone stylesheet sets a menu row's
  // height or the size of its words.
  it('no phone stylesheet sizes a menu row of its own', () => {
    const rows = familyRows();
    // The Pin row's chips and its Others key, and the rows of its Others flyout.
    for (const c of ['task-kebab-tier-btn', 'task-pin-more', 'task-pin-opt']) rows.add(c);
    const off: string[] = [];
    for (const f of walk(WEB_SRC, ['.css'])) {
      const phoneSheet = /\/phone[^/]*\.css$/.test(f);
      for (const d of scanCss(f, fs.readFileSync(f, 'utf8'))) {
        if (!/^(?:min-height|height|font-size)$/.test(d.prop)) continue;
        // A phone's rule: in a phone stylesheet, or under the phone's own condition anywhere.
        if (!phoneSheet && !d.atRules.some((a) => /max-width: ?768px/.test(a))) continue;
        for (const sel of d.selectors) {
          const last = sel.trim().split(/\s+/).pop() ?? '';
          // The Pin row's chips stay finger-sized keys; only the size of their words is the menu's.
          const sized = new Set(rows);
          if (d.prop !== 'font-size') { sized.delete('task-kebab-tier-btn'); sized.delete('task-pin-more'); }
          const menuRow = [...last.matchAll(/\.([\w-]+)/g)].some((c) => sized.has(c[1])) || (/\[role=['"]?menuitem/.test(last) && /menu/.test(sel));
          if (menuRow) off.push(`${rel(f)}:${d.line} ${sel} { ${d.prop}: ${d.value} }`);
        }
      }
    }
    expect(off, 'a menu row is sized by --overlay-row-height and --overlay-row-font (overlay-family.css)').toEqual([]);
  });
});

describe('one key-hint footer', () => {
  /** Each element whose class names a foot or hint line, with its JSX up to its closing tag. */
  function footers(src: string): Array<{ at: number; classes: string; body: string }> {
    const out: Array<{ at: number; classes: string; body: string }> = [];
    for (const m of src.matchAll(/<(div|span)\b[^>]*className=(?:"([^"]*)"|\{`([^`]*)`\})[^>]*>/g)) {
      const classes = m[2] ?? m[3];
      if (!classes.split(/\s+/).some((c) => /(?:^|-)(foot|footer|hint|hints|hintbar)$/.test(c))) continue;
      const tag = m[1];
      let depth = 1;
      let i = m.index! + m[0].length;
      const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
      re.lastIndex = i;
      let n: RegExpExecArray | null;
      while (depth && (n = re.exec(src))) { depth += n[0].startsWith('</') ? -1 : 1; i = n.index; }
      out.push({ at: m.index!, classes, body: src.slice(m.index! + m[0].length, i) });
    }
    return out;
  }

  /** A line that names a key but is not a footer of key hints: one key beside a form's own buttons
   *  ("⌘↵ to send"), or a hint inside a row or a toolbar. */
  const NOT_A_FOOTER: Record<string, string> = {
    'wn-key-hint': 'one hint inside a KeyHints footer',
    'chat-recall-hint': "the composer's line over a recalled message, inside the composer",
    'tree-path-hint': "a key hint inside the thread path bar's toolbar",
    'qb-mode-row-hint': "a quick bar mode row's own line, inside the row",
    'ceo-composer-foot': "the CEO composer's Cancel and Send, with one send hint",
    'ceo-composer-hint': "the CEO composer's one send hint",
    'passage-comment-card-edit-foot': "a comment's Cancel and Save, with one save hint",
    'passage-comment-card-edit-hint': "a comment's one save hint",
    'quote-pin-comment-foot': "a quote comment's Cancel and Save, with one save hint",
    'quote-pin-comment-hint': "a quote comment's one save hint",
    'qtc-confirm-key-hint': "the quick task confirm's one line beside its buttons",
  };
  const KEYS = /<kbd|<Key |↑↓|⏎|↵|⌘|\besc\b|\bEsc\b/;

  it('the exceptions to the footer are still in the source', () => {
    const all = tsx.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    for (const c of Object.keys(NOT_A_FOOTER)) expect(all, c).toMatch(new RegExp(`\\b${c}\\b`));
  });

  it('every footer that shows keys is wn-menu-foot (KeyHints), and its keys are wn-key', () => {
    const off: string[] = [];
    for (const f of tsx) {
      const src = fs.readFileSync(f, 'utf8');
      if (!src.includes('<kbd') && !src.includes('<Key ')) continue;
      for (const foot of footers(src)) {
        if (!KEYS.test(foot.body) || foot.classes.split(/\s+/).some((c) => c in NOT_A_FOOTER)) continue;
        const where = `${rel(f)}:${src.slice(0, foot.at).split('\n').length}`;
        if (!/\bwn-menu-foot\b/.test(foot.classes)) off.push(`${where} .${foot.classes.split(/\s+/)[0]} is not wn-menu-foot`);
        for (const k of foot.body.matchAll(/<kbd\b[^>]*>/g)) if (!/\bwn-key\b/.test(k[0])) off.push(`${where} a key without wn-key`);
      }
    }
    expect(off).toEqual([]);
  });

  it('the family draws the footer and the key; no footer or key draws its own', () => {
    expect(FAMILY_CSS).toMatch(/html \.wn-menu-foot \{/);
    expect(FAMILY_CSS).toMatch(/html \.wn-key \{/);
    const css = walk(WEB_SRC, ['.css']).filter((f) => !f.endsWith('overlay-family.css'));
    const off: string[] = [];
    for (const f of css) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/([^{}]*(?:\.wn-key|\.qb-key|wm-foot|keys-hint|cmdk-footer|\.qb-foot)(?![\w-])[^{}]*)\{([^}]*)\}/g)) {
        if (/\b(border|background|font-size|font|padding|color)\s*:/.test(m[2].replace(/--[\w-]+\s*:/g, ''))) off.push(`${rel(f)}: ${m[1].trim()}`);
      }
    }
    expect(off).toEqual([]);
  });
});

describe('a menu trigger is on while its menu is open', () => {
  it('every button a surface is placed against says it opens one (aria-haspopup)', () => {
    const off: string[] = [];
    for (const f of tsx) {
      const src = fs.readFileSync(f, 'utf8');
      const anchors = new Set([
        ...[...src.matchAll(/(?:triggerRef|anchorRef|anchor)=\{(\w+)\}/g)].map((m) => m[1]),
        ...[...src.matchAll(/useMenuPlacement\(\s*(\w+)/g)].map((m) => m[1]),
        ...[...src.matchAll(/anchorRef:\s*(\w+)/g)].map((m) => m[1]),
      ]);
      if (!anchors.size) continue;
      for (const m of src.matchAll(/<button\b[^>]*?>/gs)) {
        const ref = m[0].match(/\bref=\{(\w+)\}/);
        if (ref && anchors.has(ref[1]) && !m[0].includes('aria-haspopup')) off.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(off).toEqual([]);
  });
});
