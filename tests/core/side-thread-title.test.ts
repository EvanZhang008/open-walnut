/**
 * A side thread gets a REAL name, the way a task or a session does — not the first
 * 48 characters of what was typed. The chip row is the only place a thread is
 * identified, so a row of truncations ("another quesitons 1. Why EKS …") is the pile
 * this exists to remove.
 *
 * What these tests pin, and why each is a rule rather than a detail:
 *  - the title channel is Walnut's own FAST model, never the thread's CLI (a
 *    side_question would queue behind the answer the user is waiting for, on the very
 *    process whose cache prefix the fork design keeps byte-identical);
 *  - a failure is cosmetic: the truncated label stays and nothing throws;
 *  - the UI is told, because the drawer re-lists only when it opens.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

const backend = vi.hoisted(() => ({
  backendTitleAvailable: vi.fn<() => boolean>(),
  titleViaBackendModel: vi.fn<
    (message: string, placeholder: string, requirement: string | null) => Promise<string | null>
  >(),
}));
vi.mock('../../src/core/session-title-backend.js', () => backend);

import { WALNUT_HOME } from '../../src/constants.js';
import { addSideThread, getSideQuestion } from '../../src/core/side-questions.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import {
  refineSideThreadTitle, backfillSideThreadTitles, isDerivedLabel,
  _resetBackfillCooldownForTesting,
} from '../../src/core/sessions/side-thread-title.js';

const PARENT = 'parent-1';
const PLACEHOLDER = 'Throttling。 我去压缩前的记录里…';
const QUESTION = 'Throttling。 我去压缩前的记录里找了一下 step function 的配额';

/** Renames the server announced, in order. */
function captureRenames(): { seen: Array<{ threadId: string; title: string }>; stop: () => void } {
  const seen: Array<{ threadId: string; title: string }> = [];
  bus.subscribe('side-thread-title-observer', (event) => {
    if (event.name !== EventNames.SESSION_SIDE_THREAD_RENAMED) return;
    const d = event.data as { threadId: string; title: string };
    seen.push({ threadId: d.threadId, title: d.title });
  }, { global: true, interest: [EventNames.SESSION_SIDE_THREAD_RENAMED] });
  return { seen, stop: () => bus.unsubscribe('side-thread-title-observer') };
}

async function seedThread(id = 'sth-1'): Promise<string> {
  const entry = await addSideThread(PARENT, {
    id, question: QUESTION, threadSessionId: 'fork-1', title: PLACEHOLDER,
  });
  return entry.id;
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  vi.clearAllMocks();
  backend.backendTitleAvailable.mockReturnValue(true);
  backend.titleViaBackendModel.mockResolvedValue('Step function quota throttling');
});

describe('side-thread auto title', () => {
  it('replaces the truncated label and tells the UI', async () => {
    const id = await seedThread();
    const renames = captureRenames();

    await refineSideThreadTitle(PARENT, id, QUESTION, PLACEHOLDER);

    expect((await getSideQuestion(PARENT, id))?.title).toBe('Step function quota throttling');
    expect(renames.seen).toEqual([{ threadId: id, title: 'Step function quota throttling' }]);
    renames.stop();
  });

  it('asks the BACKEND fast model with the question and the placeholder', async () => {
    const id = await seedThread();
    await refineSideThreadTitle(PARENT, id, QUESTION, PLACEHOLDER);
    // Third argument is the plugin content requirement: a side thread has no task
    // (taskId is the '' sentinel), so there is none to obey.
    expect(backend.titleViaBackendModel).toHaveBeenCalledWith(QUESTION, PLACEHOLDER, null);
  });

  it('makes no model call when unprompted background calls are off', async () => {
    backend.backendTitleAvailable.mockReturnValue(false);
    const id = await seedThread();
    const renames = captureRenames();

    await refineSideThreadTitle(PARENT, id, QUESTION, PLACEHOLDER);

    expect(backend.titleViaBackendModel).not.toHaveBeenCalled();
    expect((await getSideQuestion(PARENT, id))?.title).toBe(PLACEHOLDER);
    expect(renames.seen).toEqual([]);
    renames.stop();
  });

  it('keeps the truncated label when the model declines, and announces nothing', async () => {
    backend.titleViaBackendModel.mockResolvedValue(null);
    const id = await seedThread();
    const renames = captureRenames();

    await refineSideThreadTitle(PARENT, id, QUESTION, PLACEHOLDER);

    expect((await getSideQuestion(PARENT, id))?.title).toBe(PLACEHOLDER);
    expect(renames.seen).toEqual([]);
    renames.stop();
  });

  it('does not announce a rename that changes nothing', async () => {
    backend.titleViaBackendModel.mockResolvedValue(PLACEHOLDER);
    const id = await seedThread();
    const renames = captureRenames();

    await refineSideThreadTitle(PARENT, id, QUESTION, PLACEHOLDER);

    expect(renames.seen).toEqual([]);
    renames.stop();
  });

  it('never throws when the model call fails — the label is cosmetic', async () => {
    backend.titleViaBackendModel.mockRejectedValue(new Error('throttled'));
    const id = await seedThread();

    await expect(refineSideThreadTitle(PARENT, id, QUESTION, PLACEHOLDER)).resolves.toBeUndefined();
    expect((await getSideQuestion(PARENT, id))?.title).toBe(PLACEHOLDER);
  });

  it('stays quiet when the thread was deleted while the model was thinking', async () => {
    const renames = captureRenames();
    await refineSideThreadTitle(PARENT, 'sth-gone', QUESTION, PLACEHOLDER);
    expect(renames.seen).toEqual([]);
    renames.stop();
  });

  it('skips an empty question outright (nothing to name)', async () => {
    const id = await seedThread();
    await refineSideThreadTitle(PARENT, id, '   ', PLACEHOLDER);
    expect(backend.titleViaBackendModel).not.toHaveBeenCalled();
  });
});

/**
 * The chips that were already there. Auto-titling fires on create, so every thread from
 * before it shipped — and every one whose model call failed — keeps the truncated
 * question forever. "Auto title still not here" was mostly THIS: a drawer full of old
 * chips that nothing would ever rename.
 */
describe('back-filling the chips that never got a title', () => {
  beforeEach(() => { _resetBackfillCooldownForTesting(); });

  it('identifies a client-truncated label without needing a marker field', () => {
    const q = 'Throttling. I went back through the pre-compaction notes for the quota';
    expect(isDerivedLabel('Throttling. I went back through…', q)).toBe(true);
    expect(isDerivedLabel(undefined, q)).toBe(true);
    expect(isDerivedLabel(q, q)).toBe(true);
    // A real title is not a prefix of the question, even when it starts the same way.
    expect(isDerivedLabel('Throttling quota facts', q)).toBe(false);
    expect(isDerivedLabel('Step function quota throttling', q)).toBe(false);
  });

  it('names only the derived labels, and leaves real titles alone', async () => {
    backend.titleViaBackendModel.mockResolvedValue('Quota throttling facts');
    await addSideThread(PARENT, { id: 'a', question: QUESTION, threadSessionId: 'f1', title: PLACEHOLDER });
    await addSideThread(PARENT, { id: 'b', question: QUESTION, threadSessionId: 'f2', title: 'Already named well' });

    await backfillSideThreadTitles(PARENT, [
      { id: 'a', title: PLACEHOLDER, question: QUESTION },
      { id: 'b', title: 'Already named well', question: QUESTION },
    ]);

    expect((await getSideQuestion(PARENT, 'a'))?.title).toBe('Quota throttling facts');
    expect((await getSideQuestion(PARENT, 'b'))?.title).toBe('Already named well');
    expect(backend.titleViaBackendModel).toHaveBeenCalledTimes(1);
  });

  it('caps how many chips one drawer open may name', async () => {
    backend.titleViaBackendModel.mockResolvedValue('Named');
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, title: PLACEHOLDER, question: QUESTION }));
    for (const r of rows) {
      await addSideThread(PARENT, { id: r.id, question: QUESTION, threadSessionId: `f-${r.id}`, title: PLACEHOLDER });
    }

    await backfillSideThreadTitles(PARENT, rows);
    // Each one is a fast-model call sharing a small concurrency pool with the rest of
    // Walnut's background work — a drawer with 30 asides must not fire 30 calls.
    expect(backend.titleViaBackendModel).toHaveBeenCalledTimes(3);
  });

  it('does not re-ask a row that just failed (cooldown), and re-asks after a reset', async () => {
    backend.titleViaBackendModel.mockResolvedValue(null);
    await addSideThread(PARENT, { id: 'a', question: QUESTION, threadSessionId: 'f1', title: PLACEHOLDER });
    const rows = [{ id: 'a', title: PLACEHOLDER, question: QUESTION }];

    await backfillSideThreadTitles(PARENT, rows);
    await backfillSideThreadTitles(PARENT, rows);
    expect(backend.titleViaBackendModel).toHaveBeenCalledTimes(1);

    _resetBackfillCooldownForTesting();
    await backfillSideThreadTitles(PARENT, rows);
    expect(backend.titleViaBackendModel).toHaveBeenCalledTimes(2);
  });

  it('makes no model call when unprompted background calls are off', async () => {
    backend.backendTitleAvailable.mockReturnValue(false);
    await backfillSideThreadTitles(PARENT, [{ id: 'a', title: PLACEHOLDER, question: QUESTION }]);
    expect(backend.titleViaBackendModel).not.toHaveBeenCalled();
  });
});
