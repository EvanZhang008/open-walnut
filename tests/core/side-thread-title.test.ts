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
import { refineSideThreadTitle } from '../../src/core/sessions/side-thread-title.js';

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
