/**
 * Unit tests for title drift refresh (maybeRefreshForkTitle in
 * src/core/session-hooks/builtins.ts + prependTopicToTitle in
 * src/core/fork-title.ts).
 *
 * A title is written once but sessions pivot; a stale title breaks title
 * search (2026-08-15 star incident). The refresh is ADDITIVE: the drifted
 * topic is PREPENDED (`New Topic · original title`), the original tail is
 * never modified or dropped, so it is safe on every task — human-named or
 * auto-named — and only the auto-added prefixes rotate.
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
import { prependTopicToTitle } from '../../src/core/fork-title.js';

beforeEach(() => {
  vi.clearAllMocks();
  updateTaskMock.mockResolvedValue({ task: { id: 't1', title: 'x' } });
});

describe('prependTopicToTitle', () => {
  it('prepends a drifted topic, keeping the original title intact', () => {
    expect(prependTopicToTitle('Fork of UI cleanup', 'Remove Star System'))
      .toBe('Remove Star System · Fork of UI cleanup');
  });

  it('returns null when the title already covers the topic (paraphrase damping)', () => {
    expect(prependTopicToTitle('Star System Removal - fork of UI polish', 'Remove Star System')).toBeNull();
    expect(prependTopicToTitle('anything', '')).toBeNull();
  });

  it('rotates auto-prefixes past the cap but NEVER drops the original tail', () => {
    const t1 = prependTopicToTitle('My precious title', 'Topic One')!;
    const t2 = prependTopicToTitle(t1, 'Topic Two')!;
    const t3 = prependTopicToTitle(t2, 'Topic Three')!;
    expect(t3).toBe('Topic Three · Topic Two · My precious title');
    expect(t3.endsWith('My precious title')).toBe(true);
  });
});

describe('maybeRefreshForkTitle (title drift refresh, all tasks)', () => {
  it('prepends the drifted topic to an auto-fork title', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Star Rating Polish - fork of UI cleanup' });
    summarizeForkPromptMock.mockResolvedValue('Context Inspector Panel');

    await maybeRefreshForkTitle('t1', 'Built the new context inspector panel; deployed.');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'Context Inspector Panel · Star Rating Polish - fork of UI cleanup' },
      { source: 'title-drift' },
    );
  });

  it('prepends on a HUMAN-named title too (additive = safe), original kept verbatim', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Retire the star system' });
    summarizeForkPromptMock.mockResolvedValue('Context Inspector Panel');

    await maybeRefreshForkTitle('t1', 'pivoted to building the context inspector');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'Context Inspector Panel · Retire the star system' },
      { source: 'title-drift' },
    );
  });

  it('skips when the title already covers the topic', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Star Rating Polish - fork of UI cleanup' });
    summarizeForkPromptMock.mockResolvedValue('Polish Star Rating');

    await maybeRefreshForkTitle('t1', 'still polishing the star rating UI');

    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('skips when the title changed during the LLM call (concurrent rename wins)', async () => {
    getTaskMock
      .mockResolvedValueOnce({ id: 't1', title: 'Old title' })
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
