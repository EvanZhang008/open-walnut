/**
 * The chat is grey (2026-11-17, the user: "change our color code for the chat to like
 * chatgpt, grey, no color, very clean"). Every chat reads one palette,
 * web/src/styles/chat-palette.css, which maps the theme's coloured tokens (--accent,
 * --success, --session-ref ...) to greys inside a chat. What that cannot reach is a colour
 * written straight into a chat rule: this guard refuses a hued colour literal in any rule
 * that styles a chat part, so a new chat rule paints with the palette's variables.
 *
 * Allowed: greys (no hue), the error red (an error keeps its colour), the fallback of a
 * variable some stylesheet defines (it is set in a chat, so the fallback never paints; one
 * of a variable nothing defines does paint, and counts), and the content's own
 * colours (a diff's added and removed lines, syntax colours, find and selection
 * highlights). The browser spec tests/e2e/browser/chat-quiet-palette.spec.ts checks the
 * drawn chat too, so a chat part under a class this list does not name is caught there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { walk, scanCss, type Decl } from './css-scan';
import { BOARD_RUNTIME_CSS } from '../../web/src/components/board/board-runtime.css';

const ROOT = join(__dirname, '..', '..');

/** Class names (prefixes) of chat parts: the timeline, its rows, cards and the composer (read off
 *  the drawn fixture chats, chat-quiet-palette.spec.ts). */
const CHAT_CLASSES = [
  'session-msg', 'session-history', 'chat-input', 'chat-send', 'chat-plus', 'chat-tool', 'chat-message',
  'chat-thinking', 'chat-panel', 'tool-run', 'tool-result', 'bash-tool', 'provenance', 'process-fold',
  'op-card', 'step-icon', 'msg-copy', 'msg-time', 'message-attachment',
  'inline-image', 'side-question', 'composer-model', 'composer-control', 'composer-direct', 'mode-toggle',
  'no-action', 'permission-request', 'ask-user', 'wn-msg', 'wn-text', 'wn-reply',
];
/** A part whose colour is the content's own (a diff line, a syntax colour), never chrome. */
const CONTENT_COLOURS = /edit-diff|::highlight|::selection|\.tk-|\.token\b|data-hl=/;
/** An ask waiting on the person keeps the theme's colours (chat-palette.css). */
const ATTENTION = /\.permission-request-card\.is-pending/;

const selectorIsChat = (sel: string) => CHAT_CLASSES.some((c) => new RegExp(`\\.${c}(?![\\w])|\\.${c}-`).test(sel));

/** Hue of a colour literal in degrees and its chroma (0..255), or null for a grey. */
function hueOf(literal: string): { hue: number; chroma: number } | null {
  let rgb: number[] | null = null;
  let alpha = 1;
  const hex = literal.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (h.length === 8) alpha = parseInt(h.slice(6, 8), 16) / 255;
  } else {
    const m = literal.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i);
    if (m) {
      rgb = [m[1], m[2], m[3]].map(Number);
      if (m[4]) alpha = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    }
  }
  if (!rgb || alpha < 0.04) return null;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma <= 14) return null;
  let hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, chroma };
}

/** The error red (#ff3b30, #d93025 ...): an error keeps its colour in a chat. */
const isErrorRed = (h: { hue: number }) => h.hue <= 10 || h.hue >= 350;

/** Colour literals of a value, leaving out the fallbacks of variables in `defined`. */
function hueLiterals(value: string, defined: Set<string>): string[] {
  let v = value;
  // Strip var(--x, fallback) innermost first, so a nested fallback goes too; an undefined
  // variable keeps its fallback, which is what paints.
  for (let i = 0; i < 5 && /var\(/.test(v); i++) {
    v = v.replace(/var\(\s*(--[\w-]+)\s*(,([^()]*(\([^()]*\))*[^()]*))?\)/g,
      (_all, name: string, _c, fallback?: string) => (defined.has(name) || !fallback ? 'VAR' : fallback));
  }
  const hsl = (v.match(/hsla?\([^)]*\)/gi) ?? []).filter((l) => {
    const sat = l.match(/^hsla?\(\s*[\d.]+(?:deg)?[,\s]+([\d.]+)%/i);
    return sat ? Number(sat[1]) > 8 : true;
  });
  const literals = v.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [];
  return [...literals.filter((l) => { const h = hueOf(l); return h !== null && !isErrorRed(h); }), ...hsl];
}

interface Offender { where: string; selector: string; prop: string; value: string }

function offendersIn(decls: Decl[], defined: Set<string>): Offender[] {
  return decls.flatMap((d) => {
    if (d.prop.startsWith('--tk-')) return [];
    const chat = d.selectors.filter((s) => selectorIsChat(s) && !CONTENT_COLOURS.test(s) && !ATTENTION.test(s));
    if (chat.length === 0) return [];
    const hues = hueLiterals(d.value, defined);
    return hues.length ? [{ where: `${d.file}:${d.line}`, selector: chat[0], prop: d.prop, value: d.value }] : [];
  });
}

const cssFiles = walk(join(ROOT, 'web/src'), ['.css']);
const cssText = new Map(cssFiles.map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]));
const decls = [
  ...[...cssText].flatMap(([file, text]) => scanCss(file, text)),
  ...scanCss('web/src/components/board/board-runtime.css.ts', BOARD_RUNTIME_CSS),
];
/** Every custom property some stylesheet sets. */
const defined = new Set(decls.filter((d) => d.prop.startsWith('--')).map((d) => d.prop));
const offenders = offendersIn(decls, defined);

describe('chat palette guard', () => {
  it('reads hue the way the eye does', () => {
    const set = new Set(['--warning', '--a', '--b', '--accent']);
    expect(hueLiterals('#007AFF', set)).toEqual(['#007AFF']);
    expect(hueLiterals('rgba(88, 86, 214, 0.08)', set)).toEqual(['rgba(88, 86, 214, 0.08)']);
    expect(hueLiterals('#f0f0f0', set)).toEqual([]);
    expect(hueLiterals('rgba(0, 0, 0, 0.2)', set)).toEqual([]);
    expect(hueLiterals('#ff3b30', set)).toEqual([]);
    expect(hueLiterals('var(--warning, #ff9500)', set)).toEqual([]);
    expect(hueLiterals('var(--a, var(--b, #ff9500))', set)).toEqual([]);
    // A variable nothing defines: its fallback is what paints.
    expect(hueLiterals('var(--color-warning, #ff9500)', set)).toEqual(['#ff9500']);
    expect(hueLiterals('color-mix(in srgb, var(--accent) 40%, #5856d6)', set)).toEqual(['#5856d6']);
    expect(hueLiterals('hsl(210 80% 50%)', set)).toEqual(['hsl(210 80% 50%)']);
    expect(hueLiterals('hsl(0 0% 50%)', set)).toEqual([]);
    expect(defined.has('--accent') && defined.has('--chat-user-bubble')).toBe(true);
  });

  it('finds the chat rules, so the scan cannot silently go empty', () => {
    // Over a thousand chat declarations today (2026-11-17: about 4,000).
    expect(decls.filter((d) => d.selectors.some(selectorIsChat)).length).toBeGreaterThan(1_000);
    // Every name in the list still styles something: a renamed part cannot drop out unseen.
    const all = [...cssText.values()].join('\n') + BOARD_RUNTIME_CSS;
    expect(CHAT_CLASSES.filter((c) => !new RegExp(`\\.${c}`).test(all))).toEqual([]);
  });

  it('every chat reads the palette', () => {
    // The rule that maps the theme's accent to grey names every chat root.
    const remap = scanCss('chat-palette.css', readFileSync(join(ROOT, 'web/src/styles/chat-palette.css'), 'utf8'))
      .find((d) => d.prop === '--accent' && d.value === 'var(--chat-grey-strong)');
    expect(remap?.selectors).toEqual(['.session-panel', '.session-history', '.chat-input-container', '.chat-panel']);
    expect(readFileSync(join(ROOT, 'web/src/styles/global-styles.ts'), 'utf8')).toContain("import './chat-palette.css';");
  });

  it('no chat rule paints a hued colour literal: use the palette\'s variables (chat-palette.css)', () => {
    expect(offenders.map((o) => `${o.where} ${o.selector} { ${o.prop}: ${o.value} }`)).toEqual([]);
  });
});
