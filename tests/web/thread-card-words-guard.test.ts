/**
 * A thread card's words, of every kind, read whole and read their links short (2026-11-22, UI
 * audit on the user's own Threads: a Needs you card's long body with two multi-line local paths
 * pushed its options and its reply box off the first screen). The words stay whole: the user's own
 * rule (2026-11-20: "the threa over here shoud show all , not just 2 line only the one show on
 * top"); what shortens a long card is its paths and addresses read as short names. The class this
 * guards is a card part that renders words its own way, so the members are enumerated from the
 * source: every component file of the Threads cards under web/src/components/org/ (a new one is
 * checked the day it lands).
 *
 *  1. Every block of agent or user words on a card reads a long path or address as a short name
 *     (`shortLinks` on each AgentText and RichMarkdown; utils/short-link-labels.ts).
 *  2. A card's own words (its summary, Walnut's stand-in, a held ask's question and reply) go
 *     through CardWords (thread-card-text.tsx), which never cuts them: no line clamp, no fold, no
 *     max height. No other element takes the summary's class or test id.
 *  3. One fold where folds exist (the ask card outside threads, a thread's answers and his own
 *     words): common/TextFold.tsx, Show more / Show less; nothing else measures a cut by hand.
 *  4. The ask card inside a thread card (a thread of a task below, a held ask) has no line clamp.
 *  5. A card's summary (the node's own, a held ask's, a card from below) draws a picture's path as
 *     the picture, as the chat does (`pictures` on its AgentText; 2026-11-23).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = path.resolve(__dirname, '../../web/src');
const ORG = path.join(WEB, 'components/org');
const read = (p: string) => fs.readFileSync(p, 'utf8');

/** Every component file of a Threads card: the org folder's *Thread* / *thread-* TSX files. */
function cardFiles(): string[] {
  return fs.readdirSync(ORG)
    .filter((f) => f.endsWith('.tsx') && /thread/i.test(f))
    .map((f) => path.join(ORG, f));
}

/** Each JSX opening tag of `name` in `src`, whole (to its closing `>` at depth 0). */
function tags(src: string, name: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0 && src[i - 1] !== '=') break;
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, i + 1) });
  }
  return out;
}

describe('thread card words', () => {
  it('finds the card files it guards', () => {
    const names = cardFiles().map((f) => path.basename(f));
    for (const f of ['OrgThreads.tsx', 'PoppedThreadCard.tsx', 'thread-card-text.tsx', 'ThreadKnown.tsx']) expect(names).toContain(f);
  });

  it('every block of words on a card reads its long links short', () => {
    const missing: string[] = [];
    for (const file of cardFiles()) {
      const src = read(file);
      for (const name of ['AgentText', 'RichMarkdown']) {
        for (const t of tags(src, name)) {
          if (!/\bshortLinks\b/.test(t.text)) missing.push(`${path.basename(file)}:${t.line} <${name}> without shortLinks`);
        }
      }
    }
    expect(missing, 'A card shows a long local path or URL as a short name (utils/short-link-labels.ts): add shortLinks').toEqual([]);
  });

  it("a card's own words are cut only by CardWords", () => {
    const strays: string[] = [];
    for (const file of cardFiles()) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        const code = line.trimStart();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('{/*')) return;
        const own = path.basename(file) === 'thread-card-text.tsx' && /function CardWords|className=\{`org-thread-summary\$/.test(line);
        if (own) return;
        if (/className=\{?["'`][^"'`]*\borg-thread-summary\b/.test(line)) strays.push(`${path.basename(file)}:${i + 1} takes the summary's class`);
        if (/testId="org-thread-(?:reply|held-question)"/.test(line) && !/<CardWords\b/.test(line)) strays.push(`${path.basename(file)}:${i + 1} names a card body outside CardWords`);
      });
    }
    expect(strays, "Render a card's words with CardWords (thread-card-text.tsx): it shows them whole").toEqual([]);
    const text = read(path.join(ORG, 'thread-card-text.tsx'));
    const fn = text.slice(text.indexOf('export function CardWords'), text.indexOf('\n}\n', text.indexOf('export function CardWords')));
    expect(fn).toMatch(/className=\{`org-thread-summary/);
    expect(fn, 'CardWords never folds or clamps').not.toMatch(/TextFold|useTextFold|wn-fold|clamp|maxHeight|org-thread-fold/);
    // Nor does any stylesheet cut the summary on a card.
    for (const f of fs.readdirSync(path.join(WEB, 'styles')).filter((x) => x.endsWith('.css'))) {
      for (const rule of read(path.join(WEB, 'styles', f)).split('}')) {
        const [sel, body = ''] = rule.split('{');
        if (!/\.org-thread-summary\b/.test(sel) || /top-thread|session-top/.test(sel)) continue;
        expect(body, `${f}: ${sel.trim()} cuts a card's words`).not.toMatch(/line-clamp:\s*\d|max-height|text-overflow:\s*ellipsis/);
      }
    }
  });

  // 2026-11-23, the user, on a Done card whose summary ended with three picture paths drawn as links:
  // "why picture is not render in the thread?". A compact AgentText draws no picture unless told.
  it("a card's summary draws its pictures, as the chat does", () => {
    const bodies: string[] = [];
    const missing: string[] = [];
    for (const file of cardFiles()) {
      const src = read(file);
      for (const t of tags(src, 'AgentText')) {
        // The summary (CardWords "org-thread-reply", the node's own or a held ask's) and the summary
        // of a card from below (its detail).
        const line = src.split('\n')[t.line - 1] ?? '';
        if (!/testId="org-thread-reply"/.test(line) && !/testId="org-thread-popped-summary"/.test(t.text)) continue;
        bodies.push(`${path.basename(file)}:${t.line}`);
        if (!/\bpictures\b/.test(t.text)) missing.push(`${path.basename(file)}:${t.line}`);
      }
    }
    expect(bodies.length, 'the scan found no card summary: the matcher broke').toBeGreaterThanOrEqual(3);
    expect(missing, "A card's summary draws a picture's path as the picture: pass `pictures` to AgentText").toEqual([]);
    expect(read(path.join(WEB, 'components/common/AgentText.tsx'))).toMatch(/inlineImages: drawsPictures/);
  });

  it('one fold: the shared TextFold, Show more / Show less', () => {
    const fold = read(path.join(WEB, 'components/common/TextFold.tsx'));
    expect(fold).toContain("more: 'Show more'");
    expect(fold).toContain("less: 'Show less'");
    expect(read(path.join(WEB, 'components/actions/AskCard.tsx'))).toMatch(/useTextFold\(/);
    for (const file of [...cardFiles(), path.join(WEB, 'components/actions/AskCard.tsx')]) {
      const src = read(file);
      expect(src, `${path.basename(file)} measures a cut itself: use common/TextFold.tsx`).not.toMatch(/\buseCutOff\b/);
      expect(src, `${path.basename(file)} writes its own fold words`).not.toMatch(/\?\s*'(?:Collapse|Less)'\s*:\s*'(?:Expand|More)'/);
    }
  });

  it('the ask card inside a thread card shows its question and why whole', () => {
    const css = read(path.join(WEB, 'styles/org-threads.css'));
    expect(css).toMatch(/\.org-thread :is\(\.ask-card-question, \.ask-card-detail\) \{ display: block; -webkit-line-clamp: unset; line-clamp: none; \}/);
    const cut = css.split('\n').filter((l) => /^\.org-thread\b[^{]*ask-card-(?:question|detail)[^{]*\{[^}]*line-clamp:\s*\d/.test(l));
    expect(cut).toEqual([]);
  });
});
