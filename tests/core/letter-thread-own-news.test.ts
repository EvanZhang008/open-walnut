/**
 * A letter's thread holds only that letter's own news, never a line pointing at another letter
 * (2026-11-03 org reflection: the thread of a letter about a deadline carried three "needs
 * your answer: ..., in its own letter" lines about unrelated decisions, written
 * by the away thread for every decision the same lead sent during the user's absence).
 *
 * Every path that adds a turn to a letter's thread is listed here with whose news it writes. A new
 * path fails until it is listed, and the away thread, the one path that ever wrote about another
 * letter, is pinned to write only the update it folds.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { planAwaySend } from '../../src/core/human-inbox/away-thread.js';
import type { LetterRecord } from '../../src/core/human-inbox/types.js';

const ROOT = path.resolve(__dirname, '../..');

/** Files outside the store that call agentReply, with whose news the turn is. */
const THREAD_WRITERS: Record<string, string> = {
  // POST /human-inbox/:id/reply and the same reply through the cloud bridge both come through agentReplyAsCaller.
  'src/core/human-inbox/letter-ops.ts': 'a session replying in its own letter (the route and the cloud relay)',
  'src/core/plugins/server-api.ts': 'a plugin replying in its own letter',
  'src/core/human-inbox/away-thread.ts': 'an away update with no letter of its own, folded as the turn itself',
};

/** Store functions that push a turn, each about the letter it is called with. */
const STORE_PUSHERS = ['agentReply', 'answerLetter', 'withdrawLetter', 'humanReplyTurn'];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(rel));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const NOW = Date.parse('2026-11-03T15:00:00Z');
const SID = 'sid-lead';
const mark = { taskId: 't-lead', since: NOW - 60 * 60_000 };
const letter = (over: Partial<LetterRecord>): LetterRecord => ({
  id: 'lt-1', subject: 'Resubmit the form today', type: 'review', bodyFormat: 'markdown', textPreview: '',
  sender: { sessionId: SID, host: 'local', taskId: 't-lead' }, createdAt: NOW - 10 * 60_000, read: false,
  bodyBytes: 1, pinned: false, archived: false, thread: [], awayThread: mark, ...over,
} as LetterRecord);

describe('a letter\'s thread holds only its own news', () => {
  it('a decision during an absence is its own letter and names no other letter', () => {
    for (const thread of [letter({}), letter({ read: true }), letter({ type: 'info' })]) {
      const plan = planAwaySend({ type: 'action_required' }, mark, SID, [thread], NOW);
      expect(plan).toMatchObject({ kind: 'new' });
      // No letter rides the plan, so nothing can be written into another letter's thread.
      expect(Object.values(plan ?? {}).some((v) => v && typeof v === 'object' && 'id' in v), JSON.stringify(plan)).toBe(false);
    }
  });

  it('the away thread writes one turn only: the update it folds, into the thread it folds into', () => {
    const text = read('src/core/human-inbox/away-thread.ts');
    const calls = text.match(/\bagentReply\s*\(\s*[^,]+/g) ?? [];
    expect(calls).toEqual(['agentReply(plan.into.id']);
    expect(text).toMatch(/text:\s*foldedTurnText\(input\)/);
    expect(text).not.toMatch(/noteInto|DECISION_NOTE/);
  });

  it('every thread writer is listed with whose news it writes', () => {
    const found = sources('src')
      .filter((f) => f !== 'src/core/human-inbox/store.ts' && /\bagentReply\s*\(/.test(read(f)))
      .sort();
    expect(found.filter((f) => !(f in THREAD_WRITERS)),
      'A new path adds a turn to a letter\'s thread: make sure it writes that letter\'s own news, then list it').toEqual([]);
    expect(found).toContain('src/core/human-inbox/away-thread.ts');
  });

  it('inside the store, only the listed functions push a turn', () => {
    const lines = read('src/core/human-inbox/store.ts').split('\n');
    let fn = '';
    const pushers = new Set<string>();
    for (const line of lines) {
      const m = /^export async function (\w+)|^async function (\w+)|^function (\w+)/.exec(line);
      if (m) fn = m[1] ?? m[2] ?? m[3];
      if (/\bletter\.thread\.push\(/.test(line)) pushers.add(fn);
    }
    expect([...pushers].sort()).toEqual([...STORE_PUSHERS].sort());
  });
});
