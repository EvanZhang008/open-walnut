/**
 * On a phone every shared control takes a finger (C19: 44 px each way, in hit testing), from ONE
 * rule at its definition, not screen by screen.
 *
 * 2026-11-27, the UI audit at 390 px on the user's data: 63 of 210 taps on the first screens were
 * 36 px or less (Org's keys and rows, the Agents and Commands cards' menu keys, Memory's rows, the
 * Time page's tabs, segments and keys, an Apps card's switch), while Home, Calendar, Routines and
 * Settings passed only because each had its own phone rules. The keys (buttons.css), tabs,
 * segments, disclosures, switches and chips (choice-controls.css) each have one phone rule now.
 *
 * This holds three things a browser walk (tests/e2e/browser/phone-finger-targets.spec.ts) cannot:
 * - each family's phone rule is there and reaches 44 px;
 * - the key's touch outset is its ::before, so a key that draws a ::before of its own (a badge, a
 *   detail line) would have that drawing moved and stretched: every ::before on a key is listed here;
 * - the switch's phone size lives at its definition only (Settings and Routines each had a copy).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanCss, walk, type Decl } from './css-scan';
import { WEB_SRC, btnCompanions, keyFiles, lastCompoundClasses } from './ui-standard-scan';

const PHONE = /max-width:\s*768px/;
const read = (rel: string) => fs.readFileSync(path.join(WEB_SRC, rel), 'utf8');
const decls = (rel: string) => scanCss(rel, read(rel));
const phoneDecls = (rel: string) => decls(rel).filter((d) => d.atRules.some((a) => PHONE.test(a)));
/** The declaration of `prop` whose selector list has one matching `sel`. */
const find = (list: Decl[], sel: RegExp, prop: string) => list.find((d) => d.prop === prop && d.selectors.some((s) => sel.test(s)));
const px44 = (v: string | undefined) => !!v && /(^|\D)44px/.test(v);
/**
 * Classes written beside `btn`, template literals read whole: btnCompanions stops at the first quote
 * inside a template (`btn ${on ? 'btn-icon' : 'btn-sm'} org-settings-btn`), and a key's own ::before
 * written on such a class must still be found.
 */
function keyClasses(): Set<string> {
  const out = btnCompanions();
  for (const file of keyFiles(['.tsx', '.ts'])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/className=\{`([^`]*)`\}/g)) {
      const words = m[1]!.match(/[A-Za-z][\w-]*/g) ?? [];
      if (words.includes('btn')) for (const w of words) out.add(w);
    }
  }
  // A component that writes `btn ...${className}`: every className a caller hands it names a key
  // (NoticeClose's region-error-close, 2026-11-27 review: static, its target spread over its notice).
  const keyComponents = new Set<string>();
  for (const file of keyFiles(['.tsx'])) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/className=\{`btn [^`]*\$\{\s*className/.test(text)) continue;
    for (const m of text.matchAll(/export (?:default )?function ([A-Z]\w*)/g)) keyComponents.add(m[1]!);
  }
  for (const file of keyFiles(['.tsx'])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/<([A-Z]\w*)\b[^>]*?\bclassName=(?:"([^"]*)"|\{['`]([^'`]*)['`]\})/g)) {
      if (!keyComponents.has(m[1]!)) continue;
      for (const w of (m[2] ?? m[3] ?? '').match(/[A-Za-z][\w-]*/g) ?? []) out.add(w);
    }
  }
  return out;
}

/** A selector without its `:has(...)` arguments: what the element contains does not make it a key. */
function withoutHas(sel: string): string {
  let out = '';
  for (let i = 0; i < sel.length; i++) {
    if (!sel.startsWith(':has(', i)) { out += sel[i]; continue; }
    let depth = 0;
    for (i += 4; i < sel.length; i++) {
      if (sel[i] === '(') depth++;
      else if (sel[i] === ')' && --depth === 0) break;
    }
  }
  return out;
}

describe('each shared control has its phone finger rule at its definition', () => {
  it('a key: 44 px wide for real (an icon key: its ::before), and a ::before 44 px tall', () => {
    const list = phoneDecls('styles/buttons.css');
    const before = /\.btn:not\(\.btn-link[^)]*\)::before$/;
    expect(px44(find(list, /\.btn:not\(\.btn-link, \.btn-icon\)$/, 'min-width')?.value), 'min-width 44px').toBe(true);
    // An icon key keeps its square; its target is 44 px wide instead.
    expect(find(list, /\.btn-icon:not\(\[data-detail\]\)::before$/, 'width')?.value).toBe('max(100%, 44px)');
    expect(find(list, before, 'height')?.value).toBe('max(100%, 44px)');
    expect(find(list, before, 'content')?.value).toBe("''");
    expect(find(list, before, 'position')?.value).toBe('absolute');
    expect(find(list, /:where\(\.btn:not\(\.btn-link\)\)$/, 'position')?.value).toBe('relative');
  });

  it('a tab, a segment, a disclosure line, a switch and a chip', () => {
    const list = phoneDecls('styles/choice-controls.css');
    expect(px44(find(list, /\.wn-tabs:not\(\.wn-tabs-tiles\) > \.wn-tab$/, 'min-height')?.value)).toBe(true);
    expect(px44(find(list, /\.wn-seg-item$/, 'min-height')?.value)).toBe(true);
    expect(px44(find(list, /\.wn-seg-item$/, 'min-width')?.value)).toBe(true);
    expect(px44(find(list, /\.wn-disclosure:not\(\.wn-disclosure-inline, \.wn-disclosure-icon\)$/, 'min-height')?.value)).toBe(true);
    expect(find(list, /\.toggle-switch\.settings-switch:not\(\.wn-switch-sm\)$/, 'width')?.value).toBe('51px');
    expect(find(list, /\.toggle-switch\.settings-switch:not\(\.wn-switch-sm\)$/, 'height')?.value).toBe('31px');
    // 31 px tall and 7 px past each way: a 45 px target.
    expect(find(list, /\.toggle-switch\.settings-switch:not\(\[aria-hidden='true'\]\)::before$/, 'inset')?.value).toBe('-7px -2px');
    expect(find(list, /\.wn-switch-sm:not\(\[aria-hidden='true'\]\)::before$/, 'inset')?.value, 'a small switch: 16 + 28 = 44 tall, 28 + 16 = 44 wide').toBe('-14px -8px');
    expect(find(list, /\.wn-check::before$/, 'width')?.value, 'a box: a 44 px target round its 16 px').toBe('44px');
    expect(px44(find(list, /\.wn-check-row$/, 'min-height')?.value)).toBe(true);
    expect(px44(find(list, /\.wn-pick-row$/, 'min-height')?.value)).toBe(true);
    expect(find(list, /\.wn-chip::before$/, 'height')?.value).toBe('max(100%, 44px)');
    expect(px44(find(list, /\.wn-chip$/, 'min-width')?.value)).toBe(true);
    expect(px44(find(list, /summary:not\(\.markdown-body summary, \.markdown summary\)$/, 'min-height')?.value)).toBe(true);
  });

  it('a field: at least 44 px wide', () => {
    const list = phoneDecls('styles/input-box.css');
    expect(px44(list.find((d) => d.prop === 'min-width' && d.selectors.some((x) => /:where\(input:not/.test(x)))?.value)).toBe(true);
  });

  it('no other stylesheet sizes the switch for a phone again', () => {
    const copies = walk(WEB_SRC, ['.css'])
      .map((f) => path.relative(WEB_SRC, f))
      .filter((rel) => rel !== 'styles/choice-controls.css')
      .flatMap((rel) => phoneDecls(rel))
      .filter((d) => d.selectors.some((s) => /\.toggle-switch/.test(s)) && /^(width|height|inset)$/.test(d.prop))
      .map((d) => `${d.file}:${d.line} ${d.prop}`);
    expect(copies).toEqual([]);
  });
});

/**
 * Every ::before written on a key, by file and selector, with why it may stay. A key is an element
 * with `.btn` or a class the TSX writes beside `btn`. The phone rule's own outset is not listed; a
 * new one fails here: give it ::after, or add it with the reason the outset may cover it.
 */
const KEY_BEFORE: Record<string, string> = {
  // An option row of an ask card: its ::before is the row's detail line, and the phone rule leaves
  // it out (`:not([data-detail])`); the row is taller than 44 px with its two lines.
  'components/actions/ask-card.css :: .ask-card-answer .org-answer-options .btn[data-detail]::before': 'detail line',
  'components/actions/ask-card.css :: .ask-card-answer .org-answer-options .btn.btn-primary[data-detail]::before': 'detail line',
  // The same 44 px outset, written for the session surfaces before the family had one.
  'styles/phone-fixes.css :: .app-shell-navigation .session-history .msg-more-btn::before': 'the same outset',
  'styles/phone-session.css :: .phone-topbar .phone-bar-slot .task-action-btn::before': 'the same outset',
  'styles/phone-session.css :: .app-shell-navigation :is(.session-panel, .main-page-chat, .draft-session-panel) :is( .msg-copy-btn, .chat-plus-btn, .mic-btn, .mode-toggle-pill, .composer-model-pill, .composer-direct-control )::before': 'the same outset',
};

describe('a key is a box its target can stand in', () => {
  // The target is an absolute ::before: on a static key it stands in the nearest positioned box
  // instead, 44 px tall and that box's width (2026-11-27: the phone bar's Menu key was static, and
  // its target spread over the whole bar and took the tap meant for the page's name).
  it('no stylesheet makes a key static', () => {
    const companions = keyClasses();
    const found: string[] = [];
    for (const file of walk(WEB_SRC, ['.css'])) {
      const rel = path.relative(WEB_SRC, file);
      for (const d of decls(rel)) {
        if (d.prop !== 'position' || !/^static\b/.test(d.value)) continue;
        for (const sel of d.selectors) {
          if (/::?(before|after)\s*$/.test(sel)) continue;
          const cls = lastCompoundClasses(withoutHas(sel));
          if (cls.some((c) => c === 'btn' || (companions.has(c) && !/^(is|has)-/.test(c)))) found.push(`${rel}:${d.line} ${sel.trim()}`);
        }
      }
    }
    expect(found, 'give the key position: relative (absolute and fixed keep their target too)').toEqual([]);
  });
});

describe('a key draws no ::before of its own', () => {
  it('every ::before on a key is the phone outset or listed', () => {
    const companions = keyClasses();
    const found = new Set<string>();
    for (const file of walk(WEB_SRC, ['.css'])) {
      const rel = path.relative(WEB_SRC, file);
      for (const d of decls(rel)) {
        for (const sel of d.selectors) {
          if (!/::?before\s*$/.test(sel)) continue;
          const cls = lastCompoundClasses(withoutHas(sel.replace(/::?before\s*$/, '')));
          // A state class (is-on, has-x) is written on keys and on other things alike: it names no key.
          if (!cls.some((c) => c === 'btn' || (companions.has(c) && !/^(is|has)-/.test(c)))) continue;
          const key = `${rel} :: ${sel.replace(/\s+/g, ' ').trim()}`;
          if (rel === 'styles/buttons.css' && /\.btn(-icon)?:not\([^)]*\)::before$/.test(sel)) continue;
          found.add(key);
        }
      }
    }
    const unlisted = [...found].filter((k) => !(k in KEY_BEFORE));
    expect(unlisted, 'a ::before on a key the phone outset would move: give it ::after or list it').toEqual([]);
    const gone = Object.keys(KEY_BEFORE).filter((k) => !found.has(k));
    expect(gone, 'listed but no longer in the source: drop it from the list').toEqual([]);
  });
});
