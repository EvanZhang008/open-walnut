import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listTasks: vi.fn(),
}));

vi.mock('../../src/core/task-manager.js', () => ({
  listTasks: mocks.listTasks,
}));

import { buildTaskLedger, invalidateTaskLedger, LEDGER_MAX_ENTRIES } from '../../src/core/task-ledger.js';

interface FixtureTask {
  id: string;
  title: string;
  project?: string;
  status: string;
  phase: string;
  parent_task_id?: string;
  ledger_desc?: string;
  created_at?: string;
  updated_at?: string;
  last_session_update?: string;
}

let seq = 0;
function task(overrides: Partial<FixtureTask> = {}): FixtureTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    project: 'Marina',
    status: 'todo',
    phase: 'TODO',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

describe('buildTaskLedger', () => {
  beforeEach(() => {
    mocks.listTasks.mockReset();
    mocks.listTasks.mockResolvedValue([]);
    invalidateTaskLedger();
  });

  it('renders id, one-liner, project, phase, and age per line, newest first', async () => {
    mocks.listTasks.mockResolvedValue([
      task({ id: 'old1', title: 'Older work', updated_at: daysAgo(5) }),
      task({ id: 'new1', title: 'Newer work', updated_at: daysAgo(1) }),
    ]);

    const out = await buildTaskLedger();
    const lines = out.split('\n');
    expect(lines[0]).toContain('`new1`');
    expect(lines[0]).toContain('Newer work');
    expect(lines[0]).toContain('Marina');
    expect(lines[0]).toContain('TODO');
    expect(lines[0]).toContain('1d');
    expect(lines[1]).toContain('`old1`');
  });

  it('prefers ledger_desc over the title and bounds it to one line', async () => {
    mocks.listTasks.mockResolvedValue([
      task({ id: 'd1', title: 'cryptic', ledger_desc: 'Investigate the\nlogin redirect loop' }),
    ]);
    const out = await buildTaskLedger();
    expect(out).toContain('Investigate the login redirect loop');
    expect(out).not.toContain('cryptic');
    expect(out.split('\n')).toHaveLength(1);
  });

  it('sorts by last_session_update when present (session activity beats updated_at)', async () => {
    mocks.listTasks.mockResolvedValue([
      task({ id: 'edited', updated_at: daysAgo(1) }),
      task({ id: 'chatted', updated_at: daysAgo(10), last_session_update: daysAgo(0) }),
    ]);
    const out = await buildTaskLedger();
    expect(out.indexOf('`chatted`')).toBeLessThan(out.indexOf('`edited`'));
  });

  it('filters junk projects, probe titles, children, and .metadata rows', async () => {
    mocks.listTasks.mockResolvedValue([
      task({ id: 'keep', title: 'Real work' }),
      task({ id: 'junk1', project: 'VerifyCat' }),
      task({ id: 'junk2', project: '', title: 'Burst message echo test' }),
      task({ id: 'child', parent_task_id: 'keep' }),
      task({ id: 'meta', title: '.metadata_project' }),
    ]);
    const out = await buildTaskLedger();
    expect(out).toContain('`keep`');
    for (const gone of ['junk1', 'junk2', 'child', 'meta']) {
      expect(out).not.toContain(`\`${gone}\``);
    }
  });

  it('drops done tasks older than 30 days but keeps recent done ones', async () => {
    mocks.listTasks.mockResolvedValue([
      task({ id: 'oldDone', status: 'done', phase: 'COMPLETE', updated_at: daysAgo(45) }),
      task({ id: 'newDone', status: 'done', phase: 'COMPLETE', updated_at: daysAgo(2) }),
    ]);
    const out = await buildTaskLedger();
    expect(out).toContain('`newDone`');
    expect(out).toContain('done');
    expect(out).not.toContain('`oldDone`');
  });

  it(`caps at ${LEDGER_MAX_ENTRIES} entries`, async () => {
    mocks.listTasks.mockResolvedValue(
      Array.from({ length: LEDGER_MAX_ENTRIES + 20 }, (_, i) =>
        task({ id: `bulk-${i}`, updated_at: daysAgo(i % 20) })),
    );
    const out = await buildTaskLedger();
    expect(out.split('\n')).toHaveLength(LEDGER_MAX_ENTRIES);
  });

  it('caches the render and rebuilds after invalidateTaskLedger()', async () => {
    mocks.listTasks.mockResolvedValue([task({ id: 'a' })]);
    await buildTaskLedger();
    await buildTaskLedger();
    expect(mocks.listTasks).toHaveBeenCalledTimes(1);

    invalidateTaskLedger();
    await buildTaskLedger();
    expect(mocks.listTasks).toHaveBeenCalledTimes(2);
  });

  it('returns "" on empty store and on listTasks failure (never throws)', async () => {
    expect(await buildTaskLedger()).toBe('');
    invalidateTaskLedger();
    mocks.listTasks.mockRejectedValue(new Error('boom'));
    await expect(buildTaskLedger()).resolves.toBe('');
  });
});
