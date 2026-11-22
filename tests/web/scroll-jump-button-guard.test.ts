/**
 * Every button that jumps a scrolling view back to its end is ONE component with ONE look:
 * common/ScrollToBottomButton.tsx, styled only by styles/scroll-jump.css (a frosted-glass circle,
 * centred at the bottom of its scroller).
 *
 * 2026-11-22, the user, of the session timeline's jump arrow (a small grey ellipse at the lower
 * right, half over the last line): "this button so ugly, need to be round and in middle, and
 * galss". At the time there were three looks: the desktop's grey circle at the right, the phone's
 * "Latest" / "3 new" text pill, and a letter's blue "New reply ↓" pill. Each check below fails when
 * a new member of that class is drawn on its own.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../web/src');
const COMPONENT = path.join('components', 'common', 'ScrollToBottomButton.tsx');
const SHEET = path.join('styles', 'scroll-jump.css');

function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(full, exts));
    else if (exts.some((x) => e.name.endsWith(x)) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const rel = (f: string) => path.relative(WEB, f);

/** Words that name a jump of a scrolled view: an accessible name, a title or a button's text. */
const JUMP_WORDS = /\b(?:scroll|jump|go|back)\s+to\s+(?:the\s+)?(?:bottom|latest|end|newest|top)\b|\bnew\s+(?:repl(?:y|ies)|messages?)\s*(?:below|↓|\\u2193)|\blatest\s*(?:↓|\\u2193)/i;
/** A CSS class that reads as a jump control of its own. */
const JUMP_CLASS = /\.((?:[\w-]*-)?(?:scroll-to-(?:bottom|top|latest|end)|jump-to-(?:bottom|latest|end|top)|back-to-top|new-reply|new-messages|latest-jump|jump-(?:pill|btn|button))[\w-]*)/g;

describe('scroll-jump buttons are one shared component', () => {
  it('only ScrollToBottomButton writes the class, and every jump button renders it', () => {
    const bad: string[] = [];
    for (const f of files(WEB, ['.tsx', '.ts'])) {
      if (rel(f) === COMPONENT) continue;
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
        if (/\bscroll-to-bottom-(?:btn|badge)\b/.test(m[1] ?? m[2] ?? m[3] ?? '')) bad.push(`${rel(f)}: draws .scroll-to-bottom-btn itself`);
      }
      // The words of a jump, outside the shared button's own `label` prop.
      const outside = src.replace(/<ScrollToBottomButton\b[\s\S]*?\/>/g, '');
      if (!/\.tsx$/.test(f)) continue;
      for (const m of outside.matchAll(/(?:aria-label|title)=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})|>([^<>{}]+)</g)) {
        const words = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
        if (JUMP_WORDS.test(words)) bad.push(`${rel(f)}: "${words.trim().slice(0, 60)}" is a jump button of its own: render <ScrollToBottomButton>`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('only scroll-jump.css styles it, and no stylesheet draws a jump control of its own', () => {
    const bad: string[] = [];
    for (const f of files(WEB, ['.css'])) {
      if (rel(f) === SHEET) continue;
      const css = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
        const selector = m[1].trim();
        for (const c of selector.matchAll(JUMP_CLASS)) {
          if (c[1] === 'hib-new-reply-seat') continue; // the letter's seat: a position, not a look
          bad.push(`${rel(f)}: ${selector.replace(/\s+/g, ' ').slice(0, 100)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('the shared look is a centred circle of frosted glass', () => {
    const css = stripComments(fs.readFileSync(path.join(WEB, SHEET), 'utf8'));
    const base = css.match(/(?:^|\})\s*\.scroll-to-bottom-btn\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(base).toMatch(/border-radius:\s*50%/);
    expect(base).toMatch(/align-self:\s*center/);
    expect(base).toMatch(/width:\s*36px/);
    expect(base).toMatch(/height:\s*36px/);
    const tsx = fs.readFileSync(path.join(WEB, COMPONENT), 'utf8');
    expect(tsx).toMatch(/scroll-to-bottom-btn wn-glass-frost/);
  });
});
