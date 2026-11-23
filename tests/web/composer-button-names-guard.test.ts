/**
 * The composer's two buttons keep the user's names, "Notes" (the session note) and "btw" (the side
 * chat): he asked for them back (2026-11-22, 11-23) after dc9949e416 (11-22) had renamed them
 * "Session note" and "Side chat". Every place reads SESSION_NOTE_LABEL / SIDE_CHAT_LABEL from
 * composer-words.ts; a new place that writes an old name, or its own copy of one, fails here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { SESSION_NOTE_LABEL, SIDE_CHAT_LABEL } from '../../web/src/components/chat/composer-words';

const root = path.resolve(import.meta.dirname, '../..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(n) ? [p] : [];
  });
}

describe('the composer\'s two buttons keep the user\'s names: Notes and btw', () => {
  it('the shared labels read Notes and btw', () => {
    expect(SESSION_NOTE_LABEL).toBe('Notes');
    expect(SIDE_CHAT_LABEL).toBe('btw');
  });

  it('no web file shows "Session note" or "Side chat" as words a person reads', () => {
    // A string literal or JSX text holding an old name; comments may still say them.
    const shown = /(['"`>])\s*(?:Session note|Side chat)\s*(['"`<])/;
    const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hits = files(path.join(root, 'web/src')).filter((f) => shown.test(code(f)))
      .map((f) => path.relative(root, f));
    expect(hits).toEqual([]);
  });
});
