/**
 * The letter index's CONTENT CLOCK — what makes a concurrent write resolvable.
 *
 * index.json is written by more than one box (the primary, and historically a
 * cloud replica's auto-commit), and the file itself carried no write order: when
 * two copies disagreed, the winner was whichever one git happened to keep, so a
 * letter the human had read came back unread (2026-08-30).
 *
 * The fix that RESOLVES that is one field, and the rest is recorded history:
 *
 *   - top-level `lastUpdated` on EVERY save. This is the only clock that decides
 *     anything today: it is the exact field git-sync's LWW merge reads
 *     (`contentClockMs` in src/integrations/git-sync.ts looks for a top-level
 *     `lastUpdated` ISO string), so it has to be top-level, a string, and
 *     Date.parse-able — a nested or renamed stamp silently degrades the merge back
 *     to commit time, which is the phase of a 30s tick, not data freshness.
 *   - per-letter `readAt`, stamped when the read flag CHANGES. NOT used by the
 *     merge and not read by anything yet; it is asserted here because a boolean's
 *     history cannot be recovered later, so it has to be correct from the start.
 *   - per-letter `bodyBytes`, which IS load-bearing: a box holding only a copy of
 *     the body compares its own file against it (see serveLetterBody).
 *
 * WALNUT_HOME is an isolated tmpdir (createMockConstants) — no real data.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-inbox-clock'));

import {
  agentReply,
  answerLetter,
  humanInboxPaths,
  humanReply,
  sendLetter,
  setArchived,
  setPinned,
  setRead,
} from '../../src/core/human-inbox/store.js';
import type { LetterRecord, LetterSender, NewLetter } from '../../src/core/human-inbox/types.js';

const SENDER: LetterSender = { sessionId: 'sess-clock', host: 'workstation' };

function letterInput(overrides: Partial<NewLetter> = {}): NewLetter {
  return {
    subject: 'Index rebuild finished',
    type: 'info',
    markdown: 'Done in 4 minutes.',
    sender: SENDER,
    ...overrides,
  };
}

/** The index as it sits ON DISK — the bytes git-sync would compare. */
function readIndex(): { lastUpdated?: unknown; letters: LetterRecord[] } {
  return JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8'));
}

function letterOnDisk(id: string): LetterRecord {
  const found = readIndex().letters.find(l => l.id === id);
  if (!found) throw new Error(`letter ${id} missing from the index`);
  return found;
}

/** Clocks are ms-resolution; two writes in the same tick are indistinguishable. */
const tick = () => new Promise(resolve => setTimeout(resolve, 3));

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true });
});

describe('index.json carries a top-level lastUpdated', () => {
  it('stamps a parseable ISO string on the very first write', async () => {
    const before = Date.now();
    await sendLetter(letterInput());
    const { lastUpdated } = readIndex();

    expect(typeof lastUpdated).toBe('string');
    const ms = Date.parse(String(lastUpdated));
    expect(Number.isFinite(ms)).toBe(true);
    // Same field, same shape, same place git-sync's LWW reader expects.
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('moves forward on every kind of write, not just on send', async () => {
    const letter = await sendLetter(letterInput({ type: 'action_required', actions: [{ id: 'go', label: 'Go' }] }));
    const stamps: string[] = [String(readIndex().lastUpdated)];

    // One entry per mutator in the store's public API: any writer that forgot to
    // stamp would leave a repeat here, and a repeat is a write that can lose an
    // LWW merge to an older copy of the file.
    for (const write of [
      () => setRead(letter.id, true),
      () => setPinned(letter.id, true),
      () => setArchived(letter.id, true),
      () => agentReply(letter.id, { text: 'One more thing.' }),
      () => answerLetter(letter.id, { actionId: 'go' }),
      () => humanReply(letter.id, { text: 'Thanks.' }),
      () => sendLetter(letterInput({ subject: 'A second letter' })),
    ]) {
      await tick();
      await write();
      stamps.push(String(readIndex().lastUpdated));
    }

    expect(new Set(stamps).size).toBe(stamps.length);
    const ms = stamps.map(s => Date.parse(s));
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  });
});

describe('a letter records WHEN its read flag moved', () => {
  it('has no readAt until the flag actually changes', async () => {
    const letter = await sendLetter(letterInput());
    expect(letter.read).toBe(false);
    expect(letterOnDisk(letter.id).readAt).toBeUndefined();

    const before = Date.now();
    const read = await setRead(letter.id, true);
    expect(read.read).toBe(true);
    const stamped = letterOnDisk(letter.id).readAt;
    expect(typeof stamped).toBe('number');
    expect(stamped!).toBeGreaterThanOrEqual(before);
  });

  it('leaves readAt alone when the flag is set to what it already was', async () => {
    const letter = await sendLetter(letterInput());
    await setRead(letter.id, true);
    const first = letterOnDisk(letter.id).readAt!;

    await tick();
    await setRead(letter.id, true);
    expect(letterOnDisk(letter.id).readAt).toBe(first);

    // …but a real transition bumps it, including the unread direction an agent
    // reply causes: that is a state change, so it gets its own timestamp.
    await tick();
    await agentReply(letter.id, { text: 'Actually, one correction.' });
    const afterReply = letterOnDisk(letter.id);
    expect(afterReply.read).toBe(false);
    expect(afterReply.readAt!).toBeGreaterThan(first);
  });

  it('survives a re-read of the index (normalization keeps it)', async () => {
    const letter = await sendLetter(letterInput());
    await setRead(letter.id, true);
    const readAt = letterOnDisk(letter.id).readAt!;

    // A later write rewrites the WHOLE file through normalizeStore. A field that
    // normalization drops would be lost here rather than at write time.
    await tick();
    await setPinned(letter.id, true);
    const after = letterOnDisk(letter.id);
    expect(after.readAt).toBe(readAt);
    expect(after.pinned).toBe(true);
  });
});

describe('a letter records the size of its own body', () => {
  it('stamps bodyBytes from the source, so a copy can be checked against it', async () => {
    const markdown = 'A body worth measuring — ✓ with a multi-byte char.';
    const letter = await sendLetter(letterInput({ markdown }));

    expect(letter.bodyBytes).toBe(Buffer.byteLength(markdown, 'utf-8'));
    expect(letterOnDisk(letter.id).bodyBytes).toBe(letter.bodyBytes);
  });

  it('stamps it for a thread turn with a rich body too', async () => {
    const letter = await sendLetter(letterInput());
    const html = '<p>The full diff, rendered.</p>';
    const replied = await agentReply(letter.id, { text: 'Diff attached.', html });

    expect(replied.thread[0].bodyBytes).toBe(Buffer.byteLength(html, 'utf-8'));
  });
});
