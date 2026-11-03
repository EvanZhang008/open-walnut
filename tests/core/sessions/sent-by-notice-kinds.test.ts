/**
 * Walnut's own notes are never the user's words (2026-11-03, the org reflection: 13 rows holding a
 * Walnut notice read `sentBy: "person"` with no `personText`, and every task is told a person row
 * is the user's go-ahead).
 *
 * Two members of one class, both pinned here for every notice Walnut can write:
 * - a row of notes alone (any outcome, any number, hints after them) is never a person's;
 * - a row of notes in front of words a person typed is a person's, and `personText` is those words
 *   alone. The notes that ride in front of a message (history-walnut-riders.ts) were taken off
 *   before the envelope parse, so the parse saw only the words and said "no envelope here, the
 *   whole row is the person's": a status push, a place note or a wait note then read as his.
 *
 * The outcomes come from the source: every `outcome` literal anywhere in src, every rider outcome,
 * and one no code writes yet, so a new notice is covered the day it is added.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { transcriptSentBy, personTextOf } from '../../../src/core/sessions/transcript-sent-by.js';
import { parseSessionMessages } from '../../../src/core/session-history.js';
import { transcriptFromJsonl } from '../../../src/core/sessions/transcript-from-jsonl.js';
import { buildWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js';
import { RIDER_NOTICE_OUTCOMES } from '../../../src/lib/history-walnut-riders.js';
import { renderHintBlock } from '../../../src/core/hints/hint-format.js';
import { CATCH_UP_BANNER_OPEN, CATCH_UP_BANNER_CLOSE } from '../../../src/core/chat-history.js';

const SRC = path.resolve(__dirname, '../../../src');
function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = sourceFiles().map((f) => fs.readFileSync(f, 'utf8'));
const OUTCOMES = [...new Set([
  ...RIDER_NOTICE_OUTCOMES,
  ...files.flatMap((s) => [...s.matchAll(/\boutcome(?::\s*|=\\?")['"`]?([a-z][a-z0-9-]*)['"`]/g)].map((m) => m[1])),
  'a-notice-of-a-future-release',
])].sort();
/** Every envelope kind Walnut builds itself (kind: '…' in a buildWalnutMessage call). */
const KINDS = [...new Set(files.flatMap((s) => [...s.matchAll(/buildWalnutMessage\(\{\s*kind:\s*'([a-z-]+)'/g)].map((m) => m[1])))].sort();

const note = (outcome: string) => buildWalnutMessage({
  kind: 'notification', attrs: { from: 'Walnut', outcome, note: 'not a work request' },
  body: `A ${outcome} note: the user approved the deploy, so go ahead.`,
});
const hint = renderHintBlock('reply-language', 'Talk to the user in Chinese.');
const WORDS = 'is the component added for this one?';
const sentBy = (text: string) => transcriptSentBy({ role: 'user', text });

/** The same text through the real history parser (the web, task_history) and the JSONL reader (companion, host). */
function throughReaders(raw: string): Array<{ sentBy?: string; personText?: string }> {
  const jsonl = `${JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: raw }, uuid: 'u1', timestamp: '2026-11-03T02:15:08.897Z' })}\n`;
  const history = parseSessionMessages(jsonl).filter((m) => m.role === 'user').map((m) => {
    const by = transcriptSentBy(m.injected ? { ...m, injected: false } : m);
    return { sentBy: by, ...(by === 'person' && personTextOf(m.text) !== undefined ? { personText: personTextOf(m.text) } : {}) };
  });
  const reader = (transcriptFromJsonl('s', jsonl).messages as Array<{ role: string; sentBy?: string; personText?: string }>)
    .filter((m) => m.role === 'user').map(({ sentBy: by, personText }) => ({ sentBy: by, ...(personText !== undefined ? { personText } : {}) }));
  return [...history, ...reader];
}

describe('every notice Walnut writes', () => {
  it('the source lists the notices this test knows', () => {
    // The riders, the subtask and request notices, and the instruction notice at least.
    for (const o of ['moved', 'status', 'waiting', 'task-routing-policy', 'stopped', 'completed', 'timeout']) expect(OUTCOMES).toContain(o);
    expect(KINDS).toEqual(expect.arrayContaining(['notification', 'trigger', 'peer-note', 'reply', 'app-state']));
  });

  it.each(OUTCOMES)('%s: alone, batched with another note, and with hints after it, is never a person\'s', (outcome) => {
    for (const text of [note(outcome), `${note(outcome)}\n\n${note('status')}`, `${note('moved')}\n\n${note(outcome)}`]) {
      expect(sentBy(text), text.slice(0, 120)).not.toBe('person');
      for (const row of throughReaders(`${text}\n\n${hint}`)) expect(row.sentBy, outcome).not.toBe('person');
    }
  });

  it.each(OUTCOMES)('%s: in front of a person\'s words, the row is his and personText is only his words', (outcome) => {
    for (const text of [`${note(outcome)}\n\n${WORDS}`, `${note('status')}\n\n${note(outcome)}\n\n${WORDS}`]) {
      expect(sentBy(text)).toBe('person');
      expect(personTextOf(text)).toBe(WORDS);
      for (const row of throughReaders(`${text}\n\n${hint}`)) expect(row, outcome).toEqual({ sentBy: 'person', personText: WORDS });
    }
  });

  it.each(KINDS)('every envelope kind Walnut builds (%s) alone is never a person\'s', (kind) => {
    const text = buildWalnutMessage({ kind: kind as 'notification', attrs: { from: kind === 'notification' ? 'Walnut' : 'Lead [abcd1234]' }, body: 'Go ahead and delete it.' });
    expect(sentBy(text)).not.toBe('person');
    for (const row of throughReaders(text)) expect(row.sentBy, kind).not.toBe('person');
  });

  it('an App\'s state note in front of a person\'s words: the same', () => {
    const app = buildWalnutMessage({ kind: 'app-state', attrs: { from: 'Garden', 'about-task': 't-1', title: 'Garden state' }, body: 'Three beds watered.' });
    expect(sentBy(app)).not.toBe('person');
    expect(sentBy(`${app}\n\n${WORDS}`)).toBe('person');
    expect(personTextOf(`${app}\n\n${WORDS}`)).toBe(WORDS);
  });

  it('context Walnut added in front of a person\'s words: personText is his words alone', () => {
    const text = `${CATCH_UP_BANNER_OPEN}\nEarlier the user approved every deploy.\n${CATCH_UP_BANNER_CLOSE}\n\n${WORDS}`;
    expect(sentBy(text)).toBe('person');
    expect(personTextOf(text)).toBe(WORDS);
  });

  it('a row of the person\'s words alone has no personText (the whole row is his)', () => {
    expect(sentBy(WORDS)).toBe('person');
    expect(personTextOf(WORDS)).toBeUndefined();
  });
});
