/**
 * Durable placeholder-title reconciler (sweepPlaceholderTitles).
 *
 * Every other title trigger needs a live wrapper / healthy control pipe at the
 * moment it fires. The 2026-08-23 repro was the opposite shape: all channels
 * failed once at launch, the CLI then ran the whole session with no wrapper
 * attached, and nothing retried — the task wore `Session: walnut` for 49
 * minutes. So NO live session is registered anywhere in this file: the sweep
 * has to find the task from DISK and title it through the backend model
 * channel. Contract pinned here:
 *   - placeholder task + a real first message on the JSONL → retitled, and the
 *     title is mirrored onto the session record
 *   - already titled / human-renamed → not even a candidate, no model call
 *   - no message anywhere, or a slash command → attempt burned, placeholder kept
 *   - retries are paced by per-task exponential backoff (never per-sweep)
 *   - tasks older than 48h, done tasks, archived-session-only tasks → skipped
 *   - backend gate closed → placeholder survives untouched, and a later sweep
 *     (gate reopened) still titles it — the whole point of being durable
 *   - model answers are cleaned (markdown/quote wrappers) and refusals rejected
 *   - message pick prefers the first SUBSTANTIVE message (nudges skipped), and
 *     falls back to the disk message queue when no JSONL exists yet
 *   - codex sessions read ACP journal history, never the native JSONL reader
 *   - passes never overlap; one bad task never starves the rest of the pass
 *
 * Real: reconciler, builtins titling core, task-manager, session-tracker,
 * message queue. Fake: the two history readers, Walnut's fast model
 * (sendMessage), and the unprompted-model-call gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-title-reconciler'));

// The sweep reads the session's first user message off the JSONL.
const historyTailMock = vi.fn();
vi.mock('../../src/core/session-history.js', () => ({
  readSessionHistoryTail: (...args: unknown[]) => historyTailMock(...args),
}));

// …and off the ACP worker journal for codex sessions (a different reader — a
// codex sid sent to the native one burns the full daemon read timeout).
const acpHistoryMock = vi.fn();
vi.mock('../../src/providers/acp-session-history.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readAcpSessionHistory: (...args: unknown[]) => acpHistoryMock(...args),
}));

// Backend title channel: Walnut's own fast model. Mocked at the model edge so
// the test never touches credentials or the network.
const sendMessageMock = vi.fn();
vi.mock('../../src/agent/model.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

// Unprompted-model-call gate — flipped by the durability test.
const backendEnabled = { value: true };
vi.mock('../../src/core/cheap-model.js', () => ({
  backgroundAiDisabled: () => !backendEnabled.value,
  fastModelFor: () => 'test-fast-model',
}));

// Stubbed so nothing here reads the developer's real config.yaml / ~/.ssh/config.
// `defaults` is the one field task-manager dereferences unconditionally.
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: async () => ({ defaults: { project: '' } }),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  addTask, getTask, updateTask, completeTask, listTasks, deleteTasksBulk,
  _resetForTesting as resetTaskManager,
} from '../../src/core/task-manager.js';
import {
  createSessionRecord, getSessionByClaudeId, updateSessionRecord,
} from '../../src/core/session-tracker.js';
import { enqueueMessage, resetCache as resetQueueCache } from '../../src/core/session-message-queue.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { __resetAutoTitleState } from '../../src/core/session-hooks/builtins.js';
import { __setBackendRetryDelayForTesting } from '../../src/core/session-title-backend.js';
import {
  sweepPlaceholderTitles, __resetTitleReconcilerForTesting,
} from '../../src/core/session-title-reconciler.js';
import { defaultSessionTaskTitle } from '../../src/core/sessions/quick-start.js';
import type { Task } from '../../src/core/types.js';

const CWD = '/tmp/demo-project';
const PLACEHOLDER = defaultSessionTaskTitle(CWD); // "Session: demo-project"
const BACKOFF_STEP_MS = 6 * 60_000; // just past the first 5-min backoff arm
const ZERO = { candidates: 0, attempted: 0, retitled: 0, errors: 0 };

let sidCounter = 0;
function nextSid(): string {
  return `title-reconciler-sid-${++sidCounter}`;
}

async function makeTaskAndSession(
  sid: string,
  title = PLACEHOLDER,
  extra: { engine?: 'codex' } = {},
): Promise<Task> {
  const { task } = await addTask({ title });
  await updateTask(task.id, { cwd: CWD }, { source: 'test' });
  await createSessionRecord(sid, task.id, 'Quick Start', CWD, { title, ...extra });
  return getTask(task.id);
}

/** What the send routes actually write for an image + text message. */
const IMAGE_PREFIXED = '[Images attached (1)]\n- /tmp/x.jpg\n\nfix docx preview';

function userHistory(text: string) {
  return [
    { role: 'user', text, timestamp: 't1' },
    { role: 'assistant', text: 'working on it…', timestamp: 't2' },
  ];
}

function modelAnswer(text: string) {
  return { content: [{ type: 'text', text }] };
}

function promptAt(call: number): string {
  const opts = sendMessageMock.mock.calls[call][0] as { messages: { content: string }[] };
  return opts.messages[0].content;
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  resetQueueCache();
  // The task/session SQLite handles outlive the rm above (they keep the unlinked
  // inode open), so rows survive it. The sweep is global by design — one leftover
  // placeholder task from an earlier test would show up as an extra candidate —
  // so drop leftovers explicitly.
  const leftovers = await listTasks();
  if (leftovers.length) await deleteTasksBulk(leftovers.map((t) => t.id));
  __resetAutoTitleState(10); // shrink the in-dispatch retry pause for tests
  __resetTitleReconcilerForTesting();
  __setBackendRetryDelayForTesting(0); // never sleep on the in-call retry
  backendEnabled.value = true;
  historyTailMock.mockReset();
  historyTailMock.mockResolvedValue(null);
  acpHistoryMock.mockReset();
  acpHistoryMock.mockResolvedValue([]);
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(modelAnswer('Docx preview support'));
});

afterEach(async () => {
  __resetTitleReconcilerForTesting();
  __setBackendRetryDelayForTesting(2_000);
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('sweepPlaceholderTitles', () => {
  it('titles a wrapper-less placeholder task through the backend model channel', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue(userHistory(IMAGE_PREFIXED));

    const stats = await sweepPlaceholderTitles();

    expect(stats).toEqual({ candidates: 1, attempted: 1, retitled: 1, errors: 0 });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    // Image paths carry no titling signal — stripped before the ask.
    expect(promptAt(0)).toContain('fix docx preview');
    expect(promptAt(0)).not.toContain('/tmp/x.jpg');
    expect((sendMessageMock.mock.calls[0][0] as { config: { model?: string } }).config.model)
      .toBe('test-fast-model');
    expect((await getTask(task.id)).title).toBe('Docx preview support');
    expect((await getSessionByClaudeId(sid))?.title).toBe('Docx preview support');
  });

  it('is idempotent — a titled task is no longer a candidate', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue(userHistory(IMAGE_PREFIXED));

    await sweepPlaceholderTitles();
    sendMessageMock.mockClear();
    const second = await sweepPlaceholderTitles();

    expect(second).toEqual(ZERO);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect((await getTask(task.id)).title).toBe('Docx preview support');
  });

  it('never touches a task the human renamed', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    await updateTask(task.id, { title: 'Docx preview, my words' }, { source: 'test' });
    historyTailMock.mockResolvedValue(userHistory(IMAGE_PREFIXED));

    const stats = await sweepPlaceholderTitles();

    expect(stats).toEqual(ZERO);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect((await getTask(task.id)).title).toBe('Docx preview, my words');
  });

  it('paces retries with per-task backoff instead of re-asking every sweep', async () => {
    const sid = nextSid();
    await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue([]); // nothing on the JSONL, nothing queued
    const t0 = Date.now();

    expect(await sweepPlaceholderTitles(t0))
      .toEqual({ candidates: 1, attempted: 1, retitled: 0, errors: 0 });
    // Same instant → still a candidate, but the backoff holds the attempt back.
    expect(await sweepPlaceholderTitles(t0))
      .toEqual({ candidates: 1, attempted: 0, retitled: 0, errors: 0 });
    // Past the 5-min arm → tries again.
    expect(await sweepPlaceholderTitles(t0 + BACKOFF_STEP_MS))
      .toEqual({ candidates: 1, attempted: 1, retitled: 0, errors: 0 });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('skips tasks older than the 48h window', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue(userHistory(IMAGE_PREFIXED));

    const stats = await sweepPlaceholderTitles(Date.now() + 49 * 3600_000);

    expect(stats).toEqual(ZERO);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect((await getTask(task.id)).title).toBe(PLACEHOLDER);
  });

  it('skips done tasks (a stale title on finished work is not worth a model call)', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    await completeTask(task.id);
    historyTailMock.mockResolvedValue(userHistory(IMAGE_PREFIXED));

    const stats = await sweepPlaceholderTitles();

    expect((await getTask(task.id)).status).toBe('done');
    expect(stats).toEqual(ZERO);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('burns the attempt but asks nothing when the only message is a slash command', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue([{ role: 'user', text: '/compact', timestamp: 't1' }]);

    const stats = await sweepPlaceholderTitles();

    expect(stats).toEqual({ candidates: 1, attempted: 1, retitled: 0, errors: 0 });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect((await getTask(task.id)).title).toBe(PLACEHOLDER);
  });

  it('keeps the placeholder while the backend gate is closed, and still titles it later', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue(userHistory(IMAGE_PREFIXED));
    const t0 = Date.now();

    backendEnabled.value = false;
    const closed = await sweepPlaceholderTitles(t0);
    expect(closed).toEqual({ candidates: 1, attempted: 1, retitled: 0, errors: 0 });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect((await getTask(task.id)).title).toBe(PLACEHOLDER);

    // Durable: the gate closing burned nothing permanent — the next sweep past
    // the backoff still gets the title written.
    backendEnabled.value = true;
    const open = await sweepPlaceholderTitles(t0 + BACKOFF_STEP_MS);
    expect(open).toEqual({ candidates: 1, attempted: 1, retitled: 1, errors: 0 });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect((await getTask(task.id)).title).toBe('Docx preview support');
  });

  it('skips a task whose only session is archived', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    await updateSessionRecord(sid, { archived: true });
    historyTailMock.mockResolvedValue(userHistory(IMAGE_PREFIXED));

    const stats = await sweepPlaceholderTitles();

    expect(stats).toEqual(ZERO);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect((await getTask(task.id)).title).toBe(PLACEHOLDER);
  });

  it('rejects a refusal answer instead of writing it as the title', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue(userHistory(IMAGE_PREFIXED));
    sendMessageMock.mockResolvedValue(
      modelAnswer('I cannot determine a title for this session.'));

    const stats = await sweepPlaceholderTitles();

    expect(stats).toEqual({ candidates: 1, attempted: 1, retitled: 0, errors: 0 });
    expect((await getTask(task.id)).title).toBe(PLACEHOLDER);
  });

  it('strips markdown and quote wrappers off the answer', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue(userHistory(IMAGE_PREFIXED));
    sendMessageMock.mockResolvedValue(modelAnswer('**"Docx preview support"**'));

    const stats = await sweepPlaceholderTitles();

    expect(stats.retitled).toBe(1);
    expect((await getTask(task.id)).title).toBe('Docx preview support');
  });

  it('titles from the first SUBSTANTIVE message, not an automation nudge', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue([
      { role: 'user', text: 'continue', timestamp: 't1' },
      { role: 'user', text: 'fix the docx preview renderer in the file viewer', timestamp: 't2' },
    ]);

    const stats = await sweepPlaceholderTitles();

    expect(stats.retitled).toBe(1);
    expect(promptAt(0)).toContain('docx preview renderer');
    expect((await getTask(task.id)).title).toBe('Docx preview support');
  });

  it('retries a transient model failure inside the same attempt', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue(userHistory(IMAGE_PREFIXED));
    sendMessageMock
      .mockRejectedValueOnce(new Error('ThrottlingException'))
      .mockResolvedValue(modelAnswer('Docx preview support'));

    const stats = await sweepPlaceholderTitles();

    expect(stats).toEqual({ candidates: 1, attempted: 1, retitled: 1, errors: 0 });
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect((await getTask(task.id)).title).toBe('Docx preview support');
  });

  it('never runs two passes at once (a hung pass must not double-spend)', async () => {
    const sid = nextSid();
    await makeTaskAndSession(sid);
    let release!: (value: unknown) => void;
    historyTailMock.mockImplementation(() => new Promise((r) => { release = r; }));

    const first = sweepPlaceholderTitles();        // parks on the history read
    const second = await sweepPlaceholderTitles(); // in-flight guard trips at once
    expect(second).toEqual(ZERO);

    await vi.waitFor(() => expect(historyTailMock).toHaveBeenCalled(), { timeout: 20_000, interval: 25 });
    release(userHistory(IMAGE_PREFIXED));
    expect(await first).toEqual({ candidates: 1, attempted: 1, retitled: 1, errors: 0 });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing task — the rest of the pass still gets titled', async () => {
    const badSid = nextSid();
    const goodSid = nextSid();
    const bad = await makeTaskAndSession(badSid);
    const good = await makeTaskAndSession(goodSid);
    historyTailMock.mockImplementation(async (sid: string) => {
      if (sid === badSid) throw new Error('daemon read failed');
      return userHistory(IMAGE_PREFIXED);
    });

    const stats = await sweepPlaceholderTitles();

    expect(stats.candidates).toBe(2);
    expect(stats.attempted).toBe(2);
    expect(stats.retitled).toBe(1);
    expect((await getTask(bad.id)).title).toBe(PLACEHOLDER);
    expect((await getTask(good.id)).title).toBe('Docx preview support');
  });

  it('falls back to the disk message queue when no JSONL exists yet', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid);
    historyTailMock.mockResolvedValue([]); // CLI never spawned — nothing written
    await enqueueMessage(sid, 'fix the docx preview renderer');

    const stats = await sweepPlaceholderTitles();

    expect(stats).toEqual({ candidates: 1, attempted: 1, retitled: 1, errors: 0 });
    expect(promptAt(0)).toContain('fix the docx preview renderer');
    expect((await getTask(task.id)).title).toBe('Docx preview support');
  });

  it('reads ACP journal history for a codex session, never the native JSONL', async () => {
    const sid = nextSid();
    const task = await makeTaskAndSession(sid, PLACEHOLDER, { engine: 'codex' });
    acpHistoryMock.mockResolvedValue([
      { role: 'user', text: 'fix the docx preview renderer', timestamp: 't1' },
    ]);
    // No ACP worker exists in this shape (that IS the repro). The sweep runs
    // with noColdAttach, so the titling core must NEVER dial one — a cold
    // worker spawn per sweep attempt is exactly what that option forbids.
    const attach = vi.spyOn(sessionRunner, 'findOrAttachAcpSession').mockResolvedValue(undefined);
    try {
      const stats = await sweepPlaceholderTitles();

      expect(stats).toEqual({ candidates: 1, attempted: 1, retitled: 1, errors: 0 });
      expect(attach).not.toHaveBeenCalled();
      expect(acpHistoryMock).toHaveBeenCalledTimes(1);
      expect(historyTailMock).not.toHaveBeenCalled();
      expect(promptAt(0)).toContain('fix the docx preview renderer');
      expect((await getTask(task.id)).title).toBe('Docx preview support');
    } finally {
      attach.mockRestore();
    }
  });
});
