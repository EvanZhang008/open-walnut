/**
 * Unit tests for title drift refresh (maybeRefreshForkTitle in
 * src/core/session-hooks/builtins.ts + prependTopicToTitle in
 * src/core/fork-title.ts).
 *
 * A title is written once but sessions pivot; a stale title breaks title
 * search (2026-08-15 star incident). The refresh is ADDITIVE and MINIMAL:
 * the drifted topic (1-2 words, summarizeDriftTopic) is PREPENDED
 * (`New Topic · original title`), the original tail is never modified or
 * dropped, and at most ONE auto-prefix exists — a later drift REPLACES it
 * instead of stacking ("千层饼" titles, user feedback 2026-08-15). The
 * default posture is "don't touch": covered topics change nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted: the fork-title mock factory runs during the STATIC import below
// (before top-level consts initialize), so the mocks must be hoisted with it.
const { getTaskMock, updateTaskMock, summarizeDriftTopicMock } = vi.hoisted(() => ({
  getTaskMock: vi.fn(),
  updateTaskMock: vi.fn(),
  summarizeDriftTopicMock: vi.fn(),
}));
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: getTaskMock,
  updateTask: updateTaskMock,
}));
vi.mock('../../src/core/fork-title.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/fork-title.js')>();
  return {
    ...real,
    summarizeDriftTopic: summarizeDriftTopicMock,
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
    expect(prependTopicToTitle('Fork of UI cleanup', 'Load Test'))
      .toBe('Load Test · Fork of UI cleanup');
  });

  it('returns null when the title already covers the topic (paraphrase damping)', () => {
    expect(prependTopicToTitle('Star System Removal - fork of UI polish', 'Remove Star System')).toBeNull();
    expect(prependTopicToTitle('anything', '')).toBeNull();
  });

  it('REPLACES the previous auto-prefix instead of stacking — only one layer ever', () => {
    const t1 = prependTopicToTitle('My precious title', 'Productize')!;
    expect(t1).toBe('Productize · My precious title');
    const t2 = prependTopicToTitle(t1, 'Load Test')!;
    expect(t2).toBe('Load Test · My precious title');
    const t3 = prependTopicToTitle(t2, 'Onboarding')!;
    expect(t3).toBe('Onboarding · My precious title');
    expect(t3.endsWith('My precious title')).toBe(true);
    // Never the mille-feuille shape: exactly one separator.
    expect(t3.split(' · ')).toHaveLength(2);
  });

  it('a label sharing words with the current prefix counts as covered (no churn)', () => {
    // "Topic Two" shares 'Topic' with the existing prefix — half its words hit,
    // so the title is left alone. Don't-touch is the default posture.
    expect(prependTopicToTitle('Topic One · My precious title', 'Topic Two')).toBeNull();
  });
});

describe('maybeRefreshForkTitle (title drift refresh, all tasks)', () => {
  it('prepends the drifted topic to an auto-fork title', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Star Rating Polish - fork of UI cleanup' });
    summarizeDriftTopicMock.mockResolvedValue('Inspector');

    await maybeRefreshForkTitle('t1', 'Built the new context inspector panel; deployed.');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'Inspector · Star Rating Polish - fork of UI cleanup' },
      { source: 'title-drift' },
    );
  });

  it('prepends on a HUMAN-named title too (additive = safe), original kept verbatim', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Retire the star system' });
    summarizeDriftTopicMock.mockResolvedValue('Inspector');

    await maybeRefreshForkTitle('t1', 'pivoted to building the context inspector');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'Inspector · Retire the star system' },
      { source: 'title-drift' },
    );
  });

  it('skips when the title already covers the topic', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Star Rating Polish - fork of UI cleanup' });
    summarizeDriftTopicMock.mockResolvedValue('Star Rating');

    await maybeRefreshForkTitle('t1', 'still polishing the star rating UI');

    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('skips when the title changed during the LLM call (concurrent rename wins)', async () => {
    getTaskMock
      .mockResolvedValueOnce({ id: 't1', title: 'Old title' })
      .mockResolvedValueOnce({ id: 't1', title: 'Human renamed it meanwhile' });
    summarizeDriftTopicMock.mockResolvedValue('Inspector Panel');

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
