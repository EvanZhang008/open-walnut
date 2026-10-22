import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('task-idempotency'));
import { addTaskIdempotently, taskIdForKey, TaskCreateConflict } from '../../src/core/task-create-idempotency.js';
import { getTask } from '../../src/core/task-manager.js';

describe('Persistent create idempotency', () => {
  it('claims one deterministic legal id for concurrent calls and keeps the original after edits', async () => {
    const input = { title: 'Review one update', project: '', description: 'Human work goal' };
    const calls = await Promise.all(Array.from({ length: 6 }, () => addTaskIdempotently(input, 'neutral-key')));
    expect(new Set(calls.map(r => r.task.id))).toEqual(new Set([taskIdForKey('neutral-key')]));
    expect(calls.filter(r => !r.reused)).toHaveLength(1);
    expect(calls[0].task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await getTask(calls[0].task.id)).created_by_op).toContain('idempotent:');
    await expect(addTaskIdempotently({ ...input, title: 'Different goal' }, 'neutral-key')).rejects.toBeInstanceOf(TaskCreateConflict);
  });
  it('leaves no-key calls independent', async () => {
    const a = await addTaskIdempotently({ title: 'Independent A', project: '' });
    const b = await addTaskIdempotently({ title: 'Independent A', project: '' });
    expect(a.task.id).not.toBe(b.task.id);
  });
});
