/**
 * A fork's SESSION title, and the hand-off it carries on its first turn.
 *
 * Two facts about a fork used to disagree. The TASK was named `Fork of <source>`
 * and refined seconds later to `<2-4 word label> - fork of <source>`; the SESSION
 * record was named once, independently, and never revisited. The session's title
 * is the one that becomes the `Title [8hex]` handle `session_list` prints and
 * `session_send` accepts, so on 2026-09-11 that handle was 100+ characters of raw
 * prompt in the shape `<first 48 chars of what was typed>… - fork of <source>`
 * (session 85acbbad), and another session picked the wrong recipient off the list.
 *
 * Real stores against a temp WALNUT_HOME; only the label summarizer is stubbed
 * (nothing may reach a model) and the 'session-runner' subscriber is a FAKE that
 * records SESSION_START instead of spawning — registered under the real runner's
 * name, so it displaces a runner rather than racing one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

const forkTitle = vi.hoisted(() => ({
  summarizeForkPrompt: vi.fn(async () => 'Retry Backoff'),
  summarizeGroupLabel: vi.fn(async () => 'Reaper Work'),
}));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-fork-session-title'));
vi.mock('../../src/core/fork-title.js', () => forkTitle);

import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';
import {
  createSessionRecord, getSessionByClaudeId, _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js';
import { addTask, getTask, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { forkSessionToTask } from '../../src/core/sessions/session-controls.js';
import { adoptForkTaskTitle } from '../../src/core/sessions/fork-session-title.js';
import { createSessionRequest, REQUESTS_FILE } from '../../src/core/session-requests.js';
import type { SessionStartEvent } from '../../src/core/event-types.js';

const SOURCE_SID = '11111111-1111-4111-8111-111111111111';
/** The kind of first message that used to become the fork's title. */
const RAW_PROMPT =
  'Throttling。 I went back through the pre-compaction record: what I wrote there was '
  + 'a handful of rate facts (Distributed limiter, per-region buckets, retry budget).';

let started: SessionStartEvent[] = [];

beforeEach(async () => {
  bus.clear();
  started = [];
  forkTitle.summarizeForkPrompt.mockClear();
  forkTitle.summarizeGroupLabel.mockClear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  const sessionDb = await import('../../src/core/session-db.js');
  sessionDb.closeDb();
  _resetSessionTrackerForTesting();
  closeTaskDb();
  _resetForTesting();
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_START) started.push(event.data as SessionStartEvent);
  });
});

afterEach(async () => {
  // Let any fire-and-forget refine settle before the stores are wiped under it.
  await new Promise((r) => setTimeout(r, 30));
  bus.clear();
  closeTaskDb();
  (await import('../../src/core/session-db.js')).closeDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

/** A source task + its live session, the thing being forked. */
async function seedSource(title = 'Cluster rearchitecture'): Promise<string> {
  const { task } = await addTask({ title, project: 'Marina', pinned: true });
  await createSessionRecord(SOURCE_SID, task.id, 'Marina', '/repo/marina', {
    title: 'Session: marina',
    host: 'clouddev',
    cliModel: 'opus[1m]',
    outputFile: '/tmp/streams/source.jsonl',
  });
  return task.id;
}

/** Poll a fire-and-forget background refine until it lands. Loose budget: this
 *  machine runs suites concurrently. */
async function waitFor(read: () => Promise<string | undefined>, want: string): Promise<string | undefined> {
  for (let i = 0; i < 250; i++) {
    const got = await read();
    if (got === want) return got;
    await new Promise((r) => setTimeout(r, 20));
  }
  return read();
}

/**
 * Hold the label summarizer open so the PLACEHOLDER phase can be observed. The
 * stubbed model otherwise answers inside the same tick and the refine can beat
 * the assertion — the ordering is genuinely racy in production too, which is why
 * fork-session-title.ts reads the TASK rather than assuming an order.
 */
function holdLabel(label: string): () => void {
  let release = () => {};
  forkTitle.summarizeForkPrompt.mockImplementationOnce(
    () => new Promise<string>((resolve) => { release = () => resolve(label); }),
  );
  return () => release();
}

const sessionTitle = async (sid: string) => (await getSessionByClaudeId(sid))?.title;

describe('fork session title follows the fork TASK title', () => {
  it('is born as the task placeholder, never the prompt, then adopts the refined label', async () => {
    await seedSource();
    const release = holdLabel('Retry Backoff');

    const fork = await forkSessionToTask(SOURCE_SID, {
      create_child_task: true,
      message: RAW_PROMPT,
    });

    // The placeholder, exactly as the task wears it.
    expect(fork.title).toBe('Fork of Cluster rearchitecture');
    expect(await sessionTitle(fork.sessionId)).toBe('Fork of Cluster rearchitecture');
    // The defect this pins: no fragment of the prompt in the session title.
    expect(await sessionTitle(fork.sessionId)).not.toContain('Throttling');

    release();
    const refined = 'Retry Backoff - fork of Cluster rearchitecture';
    expect(await waitFor(async () => (await getTask(fork.taskId)).title, refined)).toBe(refined);
    // …and the SESSION follows the task, which is the whole point.
    expect(await waitFor(() => sessionTitle(fork.sessionId), refined)).toBe(refined);
  });

  it('adopts a label that landed BEFORE the record was seeded (the other order)', async () => {
    await seedSource();
    // The refine resolves immediately, so it can rewrite the task title while
    // forkSessionToTask is still seeding the session record — the order in which
    // the refine's own sync finds no session to rename. The post-seed re-read is
    // what closes it.
    forkTitle.summarizeForkPrompt.mockImplementationOnce(async () => 'Retry Backoff');

    const fork = await forkSessionToTask(SOURCE_SID, {
      create_child_task: true, message: RAW_PROMPT,
    });

    const refined = 'Retry Backoff - fork of Cluster rearchitecture';
    expect(await waitFor(async () => (await getTask(fork.taskId)).title, refined)).toBe(refined);
    expect(await waitFor(() => sessionTitle(fork.sessionId), refined)).toBe(refined);
  });

  it('an explicit title wins and the refine never overwrites it', async () => {
    await seedSource();

    const fork = await forkSessionToTask(SOURCE_SID, {
      create_child_task: true,
      child_title: 'Split the limiter',
      title: 'Limiter split session',
      message: RAW_PROMPT,
    });

    expect(await sessionTitle(fork.sessionId)).toBe('Limiter split session');
    await new Promise((r) => setTimeout(r, 60));
    // child_title short-circuits the refine outright.
    expect(forkTitle.summarizeForkPrompt).not.toHaveBeenCalled();
    expect(await sessionTitle(fork.sessionId)).toBe('Limiter split session');
  });

  it('forking onto an existing task names the session after that task', async () => {
    await seedSource();
    const { task: target } = await addTask({ title: 'Limiter budget review', project: 'Marina' });

    const fork = await forkSessionToTask(SOURCE_SID, { task_id: target.id, message: RAW_PROMPT });

    expect(await sessionTitle(fork.sessionId)).toBe('Limiter budget review');
  });
});

describe('adoptForkTaskTitle', () => {
  it('renames only a session wearing a title it was told it may replace', async () => {
    const { task } = await addTask({ title: 'Fork of Cluster rearchitecture', project: 'Marina' });
    await createSessionRecord('aaaa1111-0000-4000-8000-000000000001', task.id, 'Marina', '/repo/marina', {
      title: 'Fork of Cluster rearchitecture',
    });
    await createSessionRecord('bbbb2222-0000-4000-8000-000000000002', task.id, 'Marina', '/repo/marina', {
      title: 'A name the human typed',
    });

    const { updateTask } = await import('../../src/core/task-manager.js');
    await updateTask(task.id, { title: 'Retry Backoff - fork of Cluster rearchitecture' });

    const renamed = await adoptForkTaskTitle(task.id, ['Fork of Cluster rearchitecture']);

    expect(renamed).toBe(1);
    expect(await sessionTitle('aaaa1111-0000-4000-8000-000000000001'))
      .toBe('Retry Backoff - fork of Cluster rearchitecture');
    expect(await sessionTitle('bbbb2222-0000-4000-8000-000000000002')).toBe('A name the human typed');
  });

  it('is idempotent and never throws on an unknown task', async () => {
    const { task } = await addTask({ title: 'Fork of X', project: 'Marina' });
    await createSessionRecord('cccc3333-0000-4000-8000-000000000003', task.id, 'Marina', '/repo/marina', {
      title: 'Fork of X',
    });

    expect(await adoptForkTaskTitle(task.id, ['Fork of X'])).toBe(0); // already equal
    expect(await adoptForkTaskTitle('no-such-task', ['anything'])).toBe(0);
  });
});

describe('fork hand-off notice for pending requests', () => {
  it('leads the fork’s first message and names exactly the pending ids', async () => {
    const sourceTaskId = await seedSource();
    const a = await createSessionRequest({
      fromSessionId: SOURCE_SID, toSessionId: 'peer-1', toTaskId: 'task-peer-1',
      text: 'measure the limiter under load',
    });
    const b = await createSessionRequest({
      fromSessionId: SOURCE_SID, toSessionId: 'peer-2', toTaskId: 'task-peer-2',
      text: 'read back the retry budget',
    });
    // Someone ELSE's pending row must not leak into this fork's notice.
    const other = await createSessionRequest({
      fromSessionId: 'someone-else', toSessionId: 'peer-3', text: 'unrelated',
    });

    const fork = await forkSessionToTask(SOURCE_SID, {
      create_child_task: true, message: 'keep going on the limiter',
    });

    expect(started).toHaveLength(1);
    const message = started[0].message ?? '';
    expect(message.startsWith('<walnut-message kind="notification"')).toBe(true);
    expect(message).toContain(`about-session="${SOURCE_SID}"`);
    expect(message).toContain(`about-task="${sourceTaskId}"`);
    expect(message).toContain(a.id);
    expect(message).toContain(b.id);
    expect(message).not.toContain(other.id);
    expect(message).toContain('2 pending request(s)');
    expect(message).toContain('request_get');
    // The notice is a PREFIX: the fork's own focus directive + request survive.
    expect(message).toContain('This is a forked session.');
    expect(message).toContain('keep going on the limiter');
  });

  it('says nothing at all when the source owes nobody an answer', async () => {
    await seedSource();

    await forkSessionToTask(SOURCE_SID, {
      create_child_task: true, message: 'keep going on the limiter',
    });

    expect(started).toHaveLength(1);
    const message = started[0].message ?? '';
    expect(message).not.toContain('walnut-message');
    expect(message.startsWith('This is a forked session.')).toBe(true);
  });

  it('ignores a request the source already settled', async () => {
    await seedSource();
    const done = await createSessionRequest({
      fromSessionId: SOURCE_SID, toSessionId: 'peer-1', text: 'already answered',
    });
    const { settleReplied } = await import('../../src/core/session-requests.js');
    await settleReplied(done.id);

    await forkSessionToTask(SOURCE_SID, { create_child_task: true, message: 'carry on' });

    expect(started[0].message ?? '').not.toContain('walnut-message');
    // Sanity: the ledger really is where we think it is.
    expect(REQUESTS_FILE.startsWith(WALNUT_HOME)).toBe(true);
  });
});
