/**
 * Unit tests for the self-report TITLE directive (applyTitleDirective in
 * src/core/session-hooks/builtins.ts + appendTopicToTitle in
 * src/core/fork-title.ts).
 *
 * Title judgment rides the ONE batched turn-complete self-report — the session
 * itself answers a TITLE field (no separate cheap-model call; user direction
 * 2026-08-16). Directives:
 *   `unchanged`            → nothing (the default posture)
 *   `topic: <1-3 words>`   → append after the stable head: `original · Topic`.
 *                            A title carries at most ONE topic; a newer one
 *                            REPLACES it and the head never moves or drops
 *                            (user direction 2026-09-24 — supersedes the
 *                            2026-08-25 newest-first stacking: people find a
 *                            task by its original keyword, so it stays in front).
 *                            `prefix:` is the same directive under its old name.
 *   `rewrite: <new title>` → full replacement for a vague/long/stale title
 * A concurrent rename (human wins) makes an in-flight directive stale.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getTaskMock, updateTaskMock } = vi.hoisted(() => ({
  getTaskMock: vi.fn(),
  updateTaskMock: vi.fn(),
}));
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: getTaskMock,
  updateTask: updateTaskMock,
}));

import { applyTitleDirective } from '../../src/core/session-hooks/builtins.js';
import { appendTopicToTitle } from '../../src/core/fork-title.js';

beforeEach(() => {
  vi.clearAllMocks();
  updateTaskMock.mockResolvedValue({ task: { id: 't1', title: 'x' } });
});

describe('appendTopicToTitle', () => {
  it('appends a drifted topic after the original title, which stays in front', () => {
    expect(appendTopicToTitle('Fork of UI cleanup', 'Load Test'))
      .toBe('Fork of UI cleanup · Load Test');
  });

  it('returns null when the title already covers the topic (paraphrase damping)', () => {
    expect(appendTopicToTitle('Star System Removal - fork of UI polish', 'Remove Star System')).toBeNull();
    expect(appendTopicToTitle('anything', '')).toBeNull();
  });

  it('a newer topic replaces the previous one; the title never grows past two segments', () => {
    const t1 = appendTopicToTitle('My precious title', 'Productize')!;
    expect(t1).toBe('My precious title · Productize');
    const t2 = appendTopicToTitle(t1, 'Load Test')!;
    expect(t2).toBe('My precious title · Load Test');
    const t3 = appendTopicToTitle(t2, 'Benchmarks')!;
    expect(t3).toBe('My precious title · Benchmarks');
    expect(t3.split(' · ')).toHaveLength(2);
    expect(t3.startsWith('My precious title')).toBe(true);
  });

  it('keeps the head when the previous topic already covers the new one', () => {
    // "Audit Trail Review" shares two of three words with the sitting topic:
    // damped, so the title does not flip-flop between paraphrases.
    expect(appendTopicToTitle('Flexible trigger system design · Audit Trail', 'Audit Trail Review')).toBeNull();
  });

  it('collapses a stacking-era title (3+ segments, original LAST) to original · topic', () => {
    // The exact shape the user pointed at on 2026-09-24: two stacked prefixes
    // had pushed the name people remember to the very end.
    const legacy = 'Seven-Session Burst · Audit Trail · Flexible trigger system design';
    expect(appendTopicToTitle(legacy, 'Replay Storm'))
      .toBe('Flexible trigger system design · Replay Storm');
    // Four segments: still the last one is the original.
    expect(appendTopicToTitle('D · C · B · Original name', 'Fresh'))
      .toBe('Original name · Fresh');
  });

  it('takes a two-segment title at face value: the first segment is the head', () => {
    // Ambiguous with a stacking-era `Topic · original`; nothing recorded which
    // half was auto-added, so the new shape wins and the title settles here.
    expect(appendTopicToTitle('Productize · GC Load test', 'Flame Graphs'))
      .toBe('Productize · Flame Graphs');
  });

  it('keeps a CJK head intact and splits only on the spaced separator', () => {
    // Head is Chinese text ("session naming rules"), topic English.
    const head = '会话命名规则';
    expect(appendTopicToTitle(head, 'Keyword First')).toBe(`${head} · Keyword First`);
    // A bare middle dot without spaces is part of the name, not a separator.
    expect(appendTopicToTitle('a·b', 'Topic')).toBe('a·b · Topic');
  });

  it('tolerates an empty title and stray separators', () => {
    expect(appendTopicToTitle('', 'Only Topic')).toBe('Only Topic');
    expect(appendTopicToTitle('Head · ', 'Topic')).toBe('Head · Topic');
    expect(appendTopicToTitle(' · Head', 'Topic')).toBe('Head · Topic');
  });
});

describe('applyTitleDirective', () => {
  it('unchanged (any case) and malformed directives are no-ops', async () => {
    await applyTitleDirective('t1', 'unchanged', 'Old title');
    await applyTitleDirective('t1', 'Unchanged.', 'Old title');
    await applyTitleDirective('t1', 'something the model made up', 'Old title');
    await applyTitleDirective('t1', '', 'Old title');
    expect(getTaskMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('topic: appends at the end, the original title stays in front', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'GC Load test' });

    await applyTitleDirective('t1', 'topic: Productize', 'GC Load test');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'GC Load test · Productize' },
      { source: 'title-drift' },
    );
  });

  it('topic: replaces a previous auto-topic instead of stacking', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'GC Load test · Productize' });

    await applyTitleDirective('t1', 'topic: Memory Profiling', 'GC Load test · Productize');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'GC Load test · Memory Profiling' },
      { source: 'title-drift' },
    );
  });

  it('prefix: (the old directive name) is honoured and behaves exactly like topic:', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'GC Load test' });

    await applyTitleDirective('t1', 'prefix: Productize', 'GC Load test');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'GC Load test · Productize' },
      { source: 'title-drift' },
    );
  });

  it('topic: collapses a stacking-era three-segment title to original · topic', async () => {
    const legacy = 'Memory Profiling · Productize · GC Load test';
    getTaskMock.mockResolvedValue({ id: 't1', title: legacy });

    await applyTitleDirective('t1', 'topic: Flame Graphs', legacy);

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'GC Load test · Flame Graphs' },
      { source: 'title-drift' },
    );
  });

  it('topic: caps the label at three words', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'GC Load test' });

    await applyTitleDirective('t1', 'topic: One Two Three Four Five', 'GC Load test');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'GC Load test · One Two Three' },
      { source: 'title-drift' },
    );
  });

  it('topic: no-op when the title already covers the topic', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Star Rating Polish - fork of UI cleanup' });

    await applyTitleDirective('t1', 'topic: Star Rating', 'Star Rating Polish - fork of UI cleanup');

    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('rewrite: replaces the whole title', async () => {
    getTaskMock.mockResolvedValue({
      id: 't1', title: 'GC Load test · Productize Local Test Setup',
    });

    await applyTitleDirective(
      't1', 'rewrite: GC Load Testing & Productization',
      'GC Load test · Productize Local Test Setup',
    );

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'GC Load Testing & Productization' },
      { source: 'title-drift' },
    );
  });

  it('stale directive: concurrent rename wins (title differs from the prompted one)', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Human renamed it meanwhile' });

    await applyTitleDirective('t1', 'topic: Inspector', 'Old title the prompt showed');
    await applyTitleDirective('t1', 'rewrite: Anything', 'Old title the prompt showed');

    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('never throws on task-read failure', async () => {
    getTaskMock.mockRejectedValue(new Error('task gone'));
    await expect(applyTitleDirective('t1', 'topic: Inspector', 'Old title')).resolves.toBeUndefined();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });
});
