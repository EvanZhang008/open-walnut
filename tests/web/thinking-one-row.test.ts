/**
 * A thought is drawn by one component, SessionThinking (the step row), wherever it
 * appears in a session: no other line labelled "Thinking", and no other place that
 * prints a thought's words (2026-11-11, the user: an old "Thinking" run line stood
 * above the new thinking row, "太混乱了"). Every web source file is read, so a new
 * place that draws reasoning its own way fails here; the browser side is
 * tests/e2e/browser/session-thinking-once.spec.ts.
 *
 * And a thought on its own is the line every fold is, "> Thinking": the chevron and the
 * word, with its step row (the icon, the first line) inside, shown once the line is opened
 * (2026-11-20, the user, of one live thought drawn with its first line between two of his
 * messages: "even if only one thining shoud also collapes", then of the icon row: "collpe
 * like > Thinking ... just liek all other not even icon icon isinside te collpes").
 * SessionThinking reads where it is from InStepList, off by default, which only an opened
 * fold's body and an opened run's body turn on.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '../../web/src');
// The main (Personal AI) chat draws its own reasoning; no session renders through it.
const OWN_CHAT = new Set(['components/chat/ChatMessage.tsx']);

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('one thinking row', () => {
  const files = sources(ROOT).map((p) => ({ rel: path.relative(ROOT, p), text: fs.readFileSync(p, 'utf8') }));

  it('no run line or fold is labelled "Thinking"', () => {
    const hits = files.flatMap(({ rel, text }) =>
      [...text.matchAll(/phrase=\{?["'`]Thinking["'`]\}?/g)].map(() => rel));
    expect(hits).toEqual([]);
  });

  it('only SessionThinking prints a thought\'s words in a session', () => {
    const hits = files
      .filter(({ rel }) => !OWN_CHAT.has(rel))
      .flatMap(({ rel, text }) => [...text.matchAll(/className="chat-thinking-content"/g)].map(() => rel));
    expect(hits).toEqual(['components/sessions/SessionMessage.tsx']);
    const msg = files.find((f) => f.rel === 'components/sessions/SessionMessage.tsx')!.text;
    const at = msg.indexOf('className="chat-thinking-content"');
    const owner = msg.lastIndexOf('export function ', at);
    expect(msg.slice(owner, owner + 40)).toContain('export function SessionThinking');
  });

  it('a thought\'s first line is drawn by SessionThinking alone, and only inside an opened list of steps', () => {
    // The words row of an opened fold (StepRows FoldedWordsRow) borrows the helper for the
    // session's own words, never for reasoning.
    const WORDS_ROW = new Set(['components/sessions/StepRows.tsx']);
    const users = files.filter(({ rel, text }) => !WORDS_ROW.has(rel) && /thinkingFirstLine\(/.test(text)).map((f) => f.rel);
    expect(users).toEqual(['components/sessions/SessionMessage.tsx']);
    const msg = files.find((f) => f.rel === 'components/sessions/SessionMessage.tsx')!.text;
    const calls = [...msg.matchAll(/^.*thinkingFirstLine\(.*$/gm)].map((m) => m[0].trim()).filter((l) => !l.startsWith('export function'));
    expect(calls).toHaveLength(1);
    // The step row (its icon, its first line) is drawn only past the early return that
    // draws a thought outside an opened list as the fold line.
    const fn = msg.slice(msg.indexOf('export function SessionThinking'), msg.indexOf('export function thinkingFirstLine'));
    const foldLine = fn.indexOf('if (!inStepList) {');
    expect(foldLine).toBeGreaterThan(-1);
    const foldLineEnd = fn.indexOf('\n  }\n', foldLine);
    const line = fn.slice(foldLine, foldLineEnd);
    // The fold line is the one FoldLine every fold of the timeline draws (the hidden lines' too):
    // the chevron, then the words, nothing else.
    expect(line).toContain('<FoldLine label="Thinking"');
    expect(line).not.toContain('name="thought"');
    expect(line).not.toContain('thinkingFirstLine(');
    const foldFn = msg.slice(msg.indexOf('function FoldLine('), msg.indexOf('export function HiddenLinesFold'));
    expect(foldFn).toContain('process-fold-chevron');
    expect(foldFn).not.toContain('name="thought"');
    expect(foldFn.indexOf('process-fold-chevron')).toBeLessThan(foldFn.indexOf('{label}'));
    expect(fn.indexOf('name="thought"')).toBeGreaterThan(foldLineEnd);
    expect(fn.indexOf('thinkingFirstLine(')).toBeGreaterThan(foldLineEnd);
    // The context is off unless a body of opened steps turns it on: a fold's, a run's.
    const ctx = files.find((f) => f.rel === 'components/sessions/fold-body-context.ts')!.text;
    expect(ctx).toMatch(/export const InStepList = createContext\(false\)/);
    const providers = files.flatMap(({ rel, text }) => [...text.matchAll(/<InStepList\.Provider/g)].map(() => rel)).sort();
    expect([...new Set(providers)]).toEqual(['components/sessions/SessionMessage.tsx', 'components/sessions/TurnFolds.tsx']);
    // Each provider sits in an opened body: inline, or as the children of a FoldLine, whose body
    // is drawn only while open.
    expect(foldFn).toMatch(/\{open && <div className="process-fold-body">\{children\}<\/div>\}/);
    const providerLines = files.flatMap(({ text }) => {
      const lines = text.split('\n');
      return lines.flatMap((l, i) => (/<InStepList\.Provider/.test(l) ? [{ line: l, before: lines[i - 1] ?? '' }] : []));
    });
    for (const { line, before } of providerLines) {
      if (/<FoldLine /.test(before)) continue;
      expect(line).toMatch(/\{open && <div className="(process-fold-body|tool-run-body)">/);
    }
  });

  it('the main chat\'s thinking row shows no words until opened', () => {
    const chat = files.find((f) => f.rel === 'components/chat/ChatMessage.tsx')!.text;
    const at = chat.indexOf('export function ThinkingSection');
    const body = chat.slice(at, chat.indexOf('\n}\n', at));
    expect(body).not.toContain('tool-run-detail');
    expect(body.indexOf('block.content}')).toBeGreaterThan(body.indexOf('{open && ('));
  });
});
