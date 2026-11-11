/**
 * A thought is drawn by one component, SessionThinking (the step row), wherever it
 * appears in a session: no other line labelled "Thinking", and no other place that
 * prints a thought's words (2026-11-11, the user: an old "Thinking" run line stood
 * above the new thinking row, "太混乱了"). Every web source file is read, so a new
 * place that draws reasoning its own way fails here; the browser side is
 * tests/e2e/browser/session-thinking-once.spec.ts.
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
});
