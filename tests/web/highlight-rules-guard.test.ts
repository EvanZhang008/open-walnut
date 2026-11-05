/**
 * The ::highlight paint rules (web/src/utils/highlight-rules.ts): one unlinked sheet,
 * installed only for the highlight names registered now.
 *
 * 2026-11-01 (C38): with ~90 ::highlight rules linked, Blink resolved a highlight
 * style per name for every element on every style recalc, and a pop back to a long
 * conversation's main page spent 44 of its 91 ms recalculating style. The ratchets
 * below fail on a new ::highlight rule in a linked stylesheet, on a new file that
 * paints into the document's highlight registry, and on a highlight name the app
 * paints with no rule in highlights.css (it would paint nothing).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  PRUNE_DELAY_MS, gateHighlightRules, highlightFamily, installHighlightRules, splitHighlightRules, type HighlightRuleBlock,
} from '@/utils/highlight-rules';
import { markHighlightName } from '@/hooks/useThreadMarks';
import { THREAD_HUES } from '@/utils/thread-tree';
import { HL_SEARCH, HL_SEARCH_ACTIVE, HL_SELMATCH } from '@/utils/dom-text-search';
import { HL_COMMENT, HL_COMMENT_SENT, HL_HELD_QUOTE, HL_PIN, HL_PIN_FLASH } from '@/utils/pin-highlights';
import { HL_FIND, HL_FIND_ACTIVE, HL_PAGE_SELMATCH } from '@/utils/page-find';

const WEB_SRC = path.resolve(__dirname, '../../web/src');
const SHEET = path.join(WEB_SRC, 'styles/highlights.css');
const sheet = readFileSync(SHEET, 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(WEB_SRC);
const rel = (p: string) => path.relative(WEB_SRC, p);

/** Rule names in highlights.css. */
function namesInSheet(): Set<string> {
  return new Set([...sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/::highlight\(\s*([\w-]+)\s*\)/g)].map((m) => m[1]!));
}

describe('highlight families', () => {
  it('groups a hue, a neutral state and an -active twin', () => {
    expect(highlightFamily('thread-mark-214')).toBe('thread-mark-214');
    expect(highlightFamily('thread-mark-done-214')).toBe('thread-mark-214');
    expect(highlightFamily('thread-mark-live-214')).toBe('thread-mark-214');
    expect(highlightFamily('thread-mark-unread-neutral')).toBe('thread-mark-neutral');
    expect(highlightFamily('thread-mark-neutral')).toBe('thread-mark-neutral');
    expect(highlightFamily('walnut-find-active')).toBe('walnut-find');
    expect(highlightFamily('walnut-pin-flash')).toBe('walnut-pin');
    expect(highlightFamily('walnut-doc-comment-current')).toBe('walnut-doc-comment');
    expect(highlightFamily('walnut-comment-sent')).toBe('walnut-comment');
    expect(highlightFamily('walnut-page-selmatch')).toBe('walnut-page-selmatch');
  });
});

describe('splitHighlightRules on highlights.css', () => {
  const blocks = splitHighlightRules(sheet);

  it('reads every rule of the sheet, each under a highlight family', () => {
    const ruleCount = (sheet.replace(/\/\*[\s\S]*?\*\//g, '').match(/::highlight\(/g) ?? []).length;
    expect(blocks.length).toBe(ruleCount);
    expect(blocks.filter((b) => b.family === '').map((b) => b.css)).toEqual([]);
  });

  it('keeps a hue family whole: open, resolved and live, light and both dark forms', () => {
    const css = blocks.filter((b) => b.family === 'thread-mark-214').map((b) => b.css);
    for (const name of ['thread-mark-214', 'thread-mark-done-214', 'thread-mark-live-214']) {
      expect(css.some((c) => c.startsWith(`::highlight(${name})`))).toBe(true);
      expect(css.some((c) => c.startsWith(`[data-theme="dark"] ::highlight(${name})`))).toBe(true);
      expect(css.some((c) => c.startsWith('@media (prefers-color-scheme: dark)') && c.includes(`::highlight(${name})`))).toBe(true);
    }
  });

  it('round-trips: every block parses as one rule again', () => {
    for (const b of blocks) expect(splitHighlightRules(b.css)).toEqual([b]);
  });
});

describe('the gate', () => {
  class FakeRegistry extends Map<string, unknown> {}
  const blocks: HighlightRuleBlock[] = splitHighlightRules(sheet);

  function setup() {
    const reg = new FakeRegistry();
    const style = { textContent: '' as string | null };
    const timers: Array<{ fn: () => void; at: number }> = [];
    const clock = { t: 0 };
    const gate = gateHighlightRules(reg as never, style, blocks, (fn, ms) => { timers.push({ fn, at: clock.t + ms }); return 0; }, () => clock.t);
    /** Move the clock and run the timers that are due. */
    const advance = (ms: number) => {
      clock.t += ms;
      for (;;) {
        const due = timers.findIndex((x) => x.at <= clock.t);
        if (due < 0) break;
        timers.splice(due, 1)[0]!.fn();
      }
    };
    return { reg, style, timers, gate, advance };
  }

  it('installs nothing until a name is registered, then that family at once', () => {
    const { reg, style, gate } = setup();
    expect(style.textContent).toBe('');
    reg.set('thread-mark-done-152', {});
    expect([...gate.installed()]).toEqual(['thread-mark-152']);
    expect(style.textContent).toContain('::highlight(thread-mark-152)');
    expect(style.textContent).toContain('::highlight(thread-mark-done-152)');
    expect(style.textContent).not.toContain('thread-mark-214');
  });

  it('keeps a family while any of its names is registered, and drops it a minute after the last goes', () => {
    const { reg, style, gate, advance } = setup();
    reg.set('walnut-find', {});
    reg.set('walnut-find-active', {});
    reg.delete('walnut-find-active');
    advance(PRUNE_DELAY_MS);
    expect(gate.installed().has('walnut-find')).toBe(true);
    reg.delete('walnut-find');
    advance(PRUNE_DELAY_MS - 1);
    expect(gate.installed().has('walnut-find')).toBe(true);
    advance(1);
    expect(gate.installed().size).toBe(0);
    expect(style.textContent).toBe('');
  });

  it('a family that leaves and comes back between pages keeps its rules: the sheet is not rewritten', () => {
    const reg = new FakeRegistry();
    let text: string | null = '';
    let writes = 0;
    const style = { get textContent() { return text; }, set textContent(v: string | null) { writes++; text = v; } };
    const timers: Array<{ fn: () => void; at: number }> = [];
    const clock = { t: 0 };
    const gate = gateHighlightRules(reg as never, style, blocks, (fn, ms) => { timers.push({ fn, at: clock.t + ms }); return 0; }, () => clock.t);
    const advance = (ms: number) => {
      clock.t += ms;
      for (let due = timers.findIndex((x) => x.at <= clock.t); due >= 0; due = timers.findIndex((x) => x.at <= clock.t)) timers.splice(due, 1)[0]!.fn();
    };
    reg.set('thread-mark-214', {});
    reg.set('thread-mark-28', {});
    const before = writes;
    // A push to a page without hue 28, a pop back 30 s later, and a minute on.
    reg.delete('thread-mark-28');
    advance(30_000);
    reg.set('thread-mark-28', {});
    advance(PRUNE_DELAY_MS * 2);
    expect(writes).toBe(before);
    expect(gate.installed().has('thread-mark-28')).toBe(true);
  });

  it('clear() starts the clock for every installed family', () => {
    const { reg, gate, advance } = setup();
    reg.set('walnut-pin', {});
    reg.set('thread-mark-neutral', {});
    reg.clear();
    advance(PRUNE_DELAY_MS);
    expect(gate.installed().size).toBe(0);
  });

  it('keeps the sheet order (a dark rule after its light one)', () => {
    const { reg, style } = setup();
    reg.set('walnut-pin', {});
    const text = style.textContent!;
    expect(text.indexOf('::highlight(walnut-pin) {')).toBeLessThan(text.indexOf('[data-theme="dark"] ::highlight(walnut-pin) {'));
  });

  it('ignores a name with no rules and is installed once per registry', () => {
    const { reg, style, gate } = setup();
    reg.set('not-a-walnut-paint', {});
    expect(style.textContent).toBe('');
    expect(gateHighlightRules(reg as never, { textContent: '' }, blocks)).toBe(gate);
  });

  it('patches the prototype in a page: a wrapper handed out again is still gated (WebKit)', () => {
    // WebKit drops CSS.highlights' JS wrapper when no script holds it; the next
    // one has none of the first's own properties. The page installs on the
    // prototype so every wrapper of the registry goes through the gate.
    class Registry extends Map<string, unknown> {}
    const first = new Registry();
    const style = { textContent: '' as string | null, dataset: {} as Record<string, string> };
    const doc = {
      defaultView: { CSS: { highlights: first } },
      createElement: () => style,
      head: { appendChild: () => undefined },
    };
    // The test runner loads CSS as empty text, so the sheet is passed in.
    installHighlightRules(doc as never, sheet);
    expect(Object.getOwnPropertyNames(first)).toEqual([]);
    const again = new Registry();
    again.set('walnut-find', {});
    expect(style.textContent).toContain('::highlight(walnut-find)');
  });

  it('installs the families already registered before it', () => {
    const reg = new FakeRegistry([['walnut-held-quote', {}]]);
    const style = { textContent: '' as string | null };
    gateHighlightRules(reg as never, style, blocks);
    expect(style.textContent).toContain('::highlight(walnut-held-quote)');
  });
});

describe('ratchets', () => {
  it('no linked stylesheet has a ::highlight rule (they go in highlights.css)', () => {
    const offenders = files
      .filter((f) => f.endsWith('.css') && f !== SHEET)
      .filter((f) => /::highlight\(\s*[\w-]+\s*\)\s*[,{]/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('highlights.css is only ever imported as text', () => {
    const offenders = files
      .filter((f) => /\.(ts|tsx|css)$/.test(f))
      .filter((f) => /highlights\.css(?!\?raw)['"]/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  // Every file that paints into a highlight registry, with the names it paints in
  // THIS document. A new one fails here until its names have rules in highlights.css
  // and it is listed. Frame documents (an HTML preview's own page) bring their own
  // small sheet; since previews run in a sandboxed origin, the console no longer reaches one:
  // the preview's injected bridge script paints its marks itself (src/web/preview-bridge-script.ts).
  const PAINTERS: Record<string, readonly string[]> = {
    'hooks/useThreadMarks.ts': [
      ...THREAD_HUES.flatMap((h) => [markHighlightName(h, false), markHighlightName(h, true), markHighlightName(h, false, false, true)]),
      ...(['waiting', 'answering', 'unread', 'failed', 'read', 'resolved'] as const).map((s) => markHighlightName(0, false, true, false, s)),
      markHighlightName(0, false, true), markHighlightName(0, true, true),
    ],
    'utils/dom-text-search.ts': [HL_SEARCH, HL_SEARCH_ACTIVE, HL_SELMATCH],
    'utils/pin-highlights.ts': [HL_PIN, HL_PIN_FLASH, HL_HELD_QUOTE, HL_COMMENT, HL_COMMENT_SENT],
    'utils/page-find.ts': [HL_FIND, HL_FIND_ACTIVE, HL_PAGE_SELMATCH],
    'components/sessions/EngineSettingsPopoverBody.tsx': ['engine-settings-help-match'],
    // Mentions only (a comment, the pins' consumer, the gate itself).
    'hooks/useQuotePinPaint.ts': [],
    'components/sessions/SessionDiffView.tsx': [],
    'utils/highlight-rules.ts': [],
    // Patches registries so a removed highlight repaints in WebKit; paints nothing.
    'utils/highlight-repaint.ts': [],
  };

  it('every file that reaches a highlight registry is listed', () => {
    const touching = files
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /CSS\??\.highlights|\.highlights\b/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort();
    expect(touching).toEqual(Object.keys(PAINTERS).sort());
  });

  it('every name the app paints in its own document has a rule in highlights.css', () => {
    const have = namesInSheet();
    const missing = Object.entries(PAINTERS).flatMap(([f, names]) => names.filter((n) => !have.has(n)).map((n) => `${f}: ${n}`));
    expect(missing).toEqual([]);
  });
});
