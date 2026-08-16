/**
 * Unit tests for maybeRefreshForkTitle (src/core/session-hooks/builtins.ts).
 *
 * A fork's title is refined ONCE at creation from its first prompt; sessions
 * that pivot keep a stale title forever, which breaks title search (2026-08-15
 * star incident: the fork that removed the star system was still named after
 * its original topic). The drift refresh re-labels auto-fork titles from the
 * CURRENT summary at triage time — never touching human-authored titles.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getTaskMock = vi.fn();
const updateTaskMock = vi.fn();
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: getTaskMock,
  updateTask: updateTaskMock,
}));

const summarizeForkPromptMock = vi.fn();
vi.mock('../../src/core/fork-title.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/fork-title.js')>();
  return {
    ...real,
    summarizeForkPrompt: summarizeForkPromptMock,
  };
});

import { maybeRefreshForkTitle } from '../../src/core/session-hooks/builtins.js';

const FORK_TITLE = 'Star Rating Polish - fork of UI cleanup';

beforeEach(() => {
  vi.clearAllMocks();
  updateTaskMock.mockResolvedValue({ task: { id: 't1', title: 'x' } });
});

describe('maybeRefreshForkTitle', () => {
  it('renames an auto-fork title when the summary drifted to a new topic', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: FORK_TITLE });
    summarizeForkPromptMock.mockResolvedValue('Context Inspector Panel');

    await maybeRefreshForkTitle('t1', 'Built the new context inspector panel; deployed.');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'Context Inspector Panel - fork of UI cleanup' },
      { source: 'fork-title' },
    );
  });

  it('never rewrites a human-authored title', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Retire the star system' });
    summarizeForkPromptMock.mockResolvedValue('Whatever New Label');

    await maybeRefreshForkTitle('t1', 'totally different topic now');

    expect(summarizeForkPromptMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('skips when the new label is just a paraphrase of the current title', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: FORK_TITLE });
    summarizeForkPromptMock.mockResolvedValue('Polish Star Rating');

    await maybeRefreshForkTitle('t1', 'still polishing the star rating UI');

    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('skips when the title changed during the LLM call (concurrent rename wins)', async () => {
    getTaskMock
      .mockResolvedValueOnce({ id: 't1', title: FORK_TITLE })
      .mockResolvedValueOnce({ id: 't1', title: 'Human renamed it meanwhile' });
    summarizeForkPromptMock.mockResolvedValue('Context Inspector Panel');

    await maybeRefreshForkTitle('t1', 'new topic summary');

    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty summary and never throws on task-read failure', async () => {
    await maybeRefreshForkTitle('t1', '   ');
    expect(getTaskMock).not.toHaveBeenCalled();

    getTaskMock.mockRejectedValue(new Error('task gone'));
    await expect(maybeRefreshForkTitle('t1', 'real summary')).resolves.toBeUndefined();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });
});
