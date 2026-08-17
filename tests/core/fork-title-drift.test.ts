/**
 * Unit tests for the self-report TITLE directive (applyTitleDirective in
 * src/core/session-hooks/builtins.ts + prependTopicToTitle in
 * src/core/fork-title.ts).
 *
 * Title judgment rides the ONE batched turn-complete self-report — the session
 * itself answers a TITLE field (no separate cheap-model call; user direction
 * 2026-08-16). Directives:
 *   `unchanged`            → nothing (the default posture)
 *   `prefix: <1-3 words>`  → prepend, REPLACING any previous auto-prefix
 *                            (never stacks — the 千层饼 feedback, 2026-08-15)
 *   `rewrite: <new title>` → full replacement for a long/stale title
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
    // Never the mille-feuille shape: exactly one separator.
    expect(t2.split(' · ')).toHaveLength(2);
    expect(t2.endsWith('My precious title')).toBe(true);
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

  it('prefix: prepends in front of the title', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'GC Load test' });

    await applyTitleDirective('t1', 'prefix: Productize', 'GC Load test');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'Productize · GC Load test' },
      { source: 'title-drift' },
    );
  });

  it('prefix: replaces a previous auto-prefix instead of stacking', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Productize · GC Load test' });

    await applyTitleDirective('t1', 'prefix: Memory Profiling', 'Productize · GC Load test');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'Memory Profiling · GC Load test' },
      { source: 'title-drift' },
    );
  });

  it('prefix: caps the label at three words', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'GC Load test' });

    await applyTitleDirective('t1', 'prefix: One Two Three Four Five', 'GC Load test');

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'One Two Three · GC Load test' },
      { source: 'title-drift' },
    );
  });

  it('prefix: no-op when the title already covers the topic', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Star Rating Polish - fork of UI cleanup' });

    await applyTitleDirective('t1', 'prefix: Star Rating', 'Star Rating Polish - fork of UI cleanup');

    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('rewrite: replaces the whole title', async () => {
    getTaskMock.mockResolvedValue({
      id: 't1', title: 'Productize Personal Mode Testing · Productize Local Test Setup · GC Load test',
    });

    await applyTitleDirective(
      't1', 'rewrite: GC Load Testing & Productization',
      'Productize Personal Mode Testing · Productize Local Test Setup · GC Load test',
    );

    expect(updateTaskMock).toHaveBeenCalledWith(
      't1',
      { title: 'GC Load Testing & Productization' },
      { source: 'title-drift' },
    );
  });

  it('stale directive: concurrent rename wins (title differs from the prompted one)', async () => {
    getTaskMock.mockResolvedValue({ id: 't1', title: 'Human renamed it meanwhile' });

    await applyTitleDirective('t1', 'prefix: Inspector', 'Old title the prompt showed');
    await applyTitleDirective('t1', 'rewrite: Anything', 'Old title the prompt showed');

    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('never throws on task-read failure', async () => {
    getTaskMock.mockRejectedValue(new Error('task gone'));
    await expect(applyTitleDirective('t1', 'prefix: Inspector', 'Old title')).resolves.toBeUndefined();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });
});
