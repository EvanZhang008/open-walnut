/**
 * Tests for the side-question ("/btw") persistence store.
 * Verifies add/list/get/promote-mark/delete round-trips and per-session isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import {
  addSideQuestion,
  addSideThread,
  isSideThreadEntry,
  listSideQuestions,
  getSideQuestion,
  markPromoted,
  markThreadPromoted,
  removeSideThread,
  deleteSideQuestion,
} from '../../src/core/side-questions.js';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

describe('side-questions store', () => {
  it('adds and lists a side question for a session', async () => {
    const entry = await addSideQuestion('sess-1', 'what is hasPipe?', 'a FIFO flag');
    expect(entry.id.startsWith('bsq-')).toBe(true);
    expect(entry.question).toBe('what is hasPipe?');
    expect(entry.answer).toBe('a FIFO flag');

    const list = await listSideQuestions('sess-1');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(entry.id);
  });

  it('isolates side questions per session', async () => {
    await addSideQuestion('sess-a', 'qA', 'aA');
    await addSideQuestion('sess-b', 'qB', 'aB');
    expect(await listSideQuestions('sess-a')).toHaveLength(1);
    expect((await listSideQuestions('sess-b'))[0]!.question).toBe('qB');
  });

  it('preserves order across multiple adds', async () => {
    await addSideQuestion('s', 'first', '1');
    await addSideQuestion('s', 'second', '2');
    const list = await listSideQuestions('s');
    expect(list.map((q) => q.question)).toEqual(['first', 'second']);
  });

  it('marks an entry as promoted', async () => {
    const e = await addSideQuestion('s', 'q', 'a');
    await markPromoted('s', e.id, 'task-123');
    const got = await getSideQuestion('s', e.id);
    expect(got?.promotedTaskId).toBe('task-123');
  });

  it('deletes an entry', async () => {
    const e = await addSideQuestion('s', 'q', 'a');
    expect(await deleteSideQuestion('s', e.id)).toBe(true);
    expect(await listSideQuestions('s')).toHaveLength(0);
    // Deleting again returns false (already gone).
    expect(await deleteSideQuestion('s', e.id)).toBe(false);
  });

  it('returns empty list for an unknown session', async () => {
    expect(await listSideQuestions('never-existed')).toEqual([]);
  });
});

// Side THREADS share the same per-parent file: a thread carries a session id and
// no answer (its answer lives in that session's transcript), a legacy /btw entry
// carries an answer and no session id, and both must survive the same read.
describe('side threads in the same store', () => {
  it('round-trips a thread entry with a caller-owned id', async () => {
    const entry = await addSideThread('sess-1', {
      id: 'sth-1', question: 'why hasPipe?', threadSessionId: 'fork-sid', title: 'FIFO',
    });
    expect(entry.id).toBe('sth-1');
    expect(entry.threadSessionId).toBe('fork-sid');
    expect(entry.title).toBe('FIFO');
    expect(entry.answer).toBeUndefined();

    const got = await getSideQuestion('sess-1', 'sth-1');
    expect(got?.threadSessionId).toBe('fork-sid');
    expect(isSideThreadEntry(got!)).toBe(true);
  });

  it('reads legacy Q&As and threads out of one file', async () => {
    const legacy = await addSideQuestion('sess-mix', 'legacy q', 'legacy a');
    await addSideThread('sess-mix', { id: 'sth-2', question: 'thread q', threadSessionId: 'fork-2' });

    const list = await listSideQuestions('sess-mix');
    expect(list).toHaveLength(2);
    expect(list.filter(isSideThreadEntry).map((e) => e.id)).toEqual(['sth-2']);
    expect(list.filter((e) => !isSideThreadEntry(e)).map((e) => e.id)).toEqual([legacy.id]);
    expect(isSideThreadEntry(legacy)).toBe(false);
  });

  it('marks a thread promoted and removes it', async () => {
    await addSideThread('sess-2', { id: 'sth-3', question: 'q', threadSessionId: 'fork-3' });
    await markThreadPromoted('sess-2', 'sth-3', 'task-9');
    expect((await getSideQuestion('sess-2', 'sth-3'))?.promotedTaskId).toBe('task-9');

    expect(await removeSideThread('sess-2', 'sth-3')).toBe(true);
    expect(await listSideQuestions('sess-2')).toHaveLength(0);
    expect(await removeSideThread('sess-2', 'sth-3')).toBe(false);
  });

  it('serializes concurrent writes to one parent (no lost entry)', async () => {
    await Promise.all([
      addSideThread('sess-3', { id: 'sth-a', question: 'a', threadSessionId: 'f-a' }),
      addSideThread('sess-3', { id: 'sth-b', question: 'b', threadSessionId: 'f-b' }),
      addSideQuestion('sess-3', 'legacy', 'ans'),
    ]);
    expect(await listSideQuestions('sess-3')).toHaveLength(3);
  });
});
