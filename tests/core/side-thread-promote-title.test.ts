/**
 * What a promoted side thread is NAMED.
 *
 * The chip's label is minted client-side by truncating the question, so it is
 * "nobody has named this yet" in disguise. Promote used to pass that straight
 * through as the task's title prefix, which produced the 2026-09-11 handle: task
 * AND session both wearing `<first 48 chars of the question>… - fork of <source>`
 * (session 85acbbad), unreadable in `session_list` and unusable as a
 * `session_send` target. A truncation now hands naming back to the fork shape:
 * `Fork of <source>`, refined to `<2-4 word label> - fork of <source>`, with the
 * SESSION record following the task. A label somebody actually chose still wins.
 *
 * Real task/session/side-question stores against a temp WALNUT_HOME; the label
 * summarizer is stubbed and the session runner is a stub (promote only asks it to
 * drop the lane on a live instance).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

const forkTitle = vi.hoisted(() => ({
  summarizeForkPrompt: vi.fn(async () => 'Retry Backoff'),
  summarizeGroupLabel: vi.fn(async () => 'Reaper Work'),
}));
const syncLane = vi.hoisted(() => vi.fn());

vi.mock('../../src/constants.js', () => createMockConstants('walnut-promote-title'));
vi.mock('../../src/core/fork-title.js', () => forkTitle);
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { syncLane: (...args: unknown[]) => syncLane(...args) },
}));

import { bus } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';
import {
  createSessionRecord, getSessionByClaudeId, _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js';
import { addTask, getTask, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { addSideThread } from '../../src/core/side-questions.js';
import { promoteSideThread } from '../../src/core/sessions/side-thread-promote.js';

const PARENT = '11111111-1111-4111-8111-111111111111';
const THREAD_SID = '22222222-2222-4222-8222-222222222222';
const THREAD_ID = 'sth-1757550000-abcd';
const QUESTION =
  'Throttling. I went back through the pre-compaction record: what I wrote there was a '
  + 'handful of rate facts (distributed limiter, per-region buckets, retry budget).';
/** Exactly what the client mints for the chip: the question, cut short. */
const DERIVED_LABEL = `${QUESTION.slice(0, 48)}…`;

beforeEach(async () => {
  bus.clear();
  forkTitle.summarizeForkPrompt.mockClear();
  syncLane.mockClear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  const sessionDb = await import('../../src/core/session-db.js');
  sessionDb.closeDb();
  _resetSessionTrackerForTesting();
  closeTaskDb();
  _resetForTesting();
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 30));
  bus.clear();
  closeTaskDb();
  (await import('../../src/core/session-db.js')).closeDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

/** A parent session working a task, plus a hidden thread forked off it. */
async function seedThread(label?: string): Promise<string> {
  const { task } = await addTask({ title: 'Cluster rearchitecture', project: 'Marina', pinned: true });
  await createSessionRecord(PARENT, task.id, 'Marina', '/repo/marina', {
    title: 'Session: marina', host: 'clouddev', outputFile: '/tmp/streams/parent.jsonl',
  });
  await createSessionRecord(THREAD_SID, '', 'Marina', '/repo/marina', {
    title: `Side: Session: marina`,
    host: 'clouddev',
    lane: `side:${PARENT}:${THREAD_ID}`,
    forkedFromSessionId: PARENT,
  });
  await addSideThread(PARENT, {
    id: THREAD_ID, question: QUESTION, threadSessionId: THREAD_SID,
    ...(label ? { title: label } : {}),
  });
  return task.id;
}

async function waitFor(read: () => Promise<string | undefined>, want: string): Promise<string | undefined> {
  for (let i = 0; i < 250; i++) {
    const got = await read();
    if (got === want) return got;
    await new Promise((r) => setTimeout(r, 20));
  }
  return read();
}

/**
 * Hold the label summarizer open so the PLACEHOLDER phase can be observed.
 * Without this the stubbed model answers inside the same tick and the refine can
 * beat the assertion (it did, first run) — the ordering is genuinely racy in
 * production too, which is exactly why fork-session-title.ts reads the TASK
 * rather than assuming an order.
 */
function holdLabel(label: string): () => void {
  let release = () => {};
  forkTitle.summarizeForkPrompt.mockImplementationOnce(
    () => new Promise<string>((resolve) => { release = () => resolve(label); }),
  );
  return () => release();
}

const sessionTitle = async (sid: string) => (await getSessionByClaudeId(sid))?.title;

describe('promoteSideThread — naming', () => {
  it('treats a truncated question as unnamed: placeholder now, refined label after', async () => {
    await seedThread(DERIVED_LABEL);
    const release = holdLabel('Retry Backoff');

    const res = await promoteSideThread(PARENT, THREAD_ID);

    // Phase one: both the task and the session wear the plain placeholder, and
    // neither carries a fragment of the raw question.
    expect((await getTask(res.taskId)).title).toBe('Fork of Cluster rearchitecture');
    expect(await sessionTitle(THREAD_SID)).toBe('Fork of Cluster rearchitecture');
    expect(await sessionTitle(THREAD_SID)).not.toContain('Throttling');

    // Phase two: the label lands, and the SESSION follows the task.
    release();
    const refined = 'Retry Backoff - fork of Cluster rearchitecture';
    expect(await waitFor(async () => (await getTask(res.taskId)).title, refined)).toBe(refined);
    expect(await waitFor(() => sessionTitle(THREAD_SID), refined)).toBe(refined);
  });

  it('an entry with no label at all behaves the same way', async () => {
    await seedThread(undefined);
    const release = holdLabel('Retry Backoff');

    const res = await promoteSideThread(PARENT, THREAD_ID);

    expect((await getTask(res.taskId)).title).toBe('Fork of Cluster rearchitecture');
    expect(await sessionTitle(THREAD_SID)).toBe('Fork of Cluster rearchitecture');
    release();
  });

  it('honours a real label (the auto-titler’s, or a human’s) and skips the refine', async () => {
    await seedThread('Step function throttling');

    const res = await promoteSideThread(PARENT, THREAD_ID);

    const want = 'Step function throttling - fork of Cluster rearchitecture';
    expect((await getTask(res.taskId)).title).toBe(want);
    expect(await sessionTitle(THREAD_SID)).toBe(want);
    await new Promise((r) => setTimeout(r, 60));
    expect(forkTitle.summarizeForkPrompt).not.toHaveBeenCalled();
    expect(await sessionTitle(THREAD_SID)).toBe(want);
  });

  it('un-hides the session and files the task next to the parent’s', async () => {
    const parentTaskId = await seedThread('Step function throttling');

    const res = await promoteSideThread(PARENT, THREAD_ID);

    const record = await getSessionByClaudeId(THREAD_SID);
    expect(record?.lane).toBeUndefined();
    expect(record?.taskId).toBe(res.taskId);
    expect(res.siblingOfTaskId).toBe(parentTaskId);
    expect(syncLane).toHaveBeenCalledWith(THREAD_SID, undefined);
  });
});
