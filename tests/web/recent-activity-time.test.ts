/**
 * The Recent feed's row time and its sort share one clock
 * (web/src/components/tasks/recent-activity-time.ts). Pure logic — no React mount.
 *
 * Reported 2026-09-25: a task with no session showed "5mo ago" (its created_at)
 * while sitting near the top of the feed, which ranks by updated_at.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recentActivityTime, recentActivityTitle } from '../../web/src/components/tasks/recent-activity-time';

const base = {
  created_at: '2026-04-20T10:00:00.000Z',
  updated_at: '2026-04-20T10:00:00.000Z',
  status: 'todo' as const,
  phase: 'TODO' as const,
};

describe('recentActivityTime', () => {
  it('a task edited after creation shows the edit, not the creation (the reported bug)', () => {
    const t = { ...base, updated_at: '2026-09-04T08:00:00.000Z' };
    expect(recentActivityTime(t, 'updated')).toEqual({ at: '2026-09-04T08:00:00.000Z', kind: 'updated' });
  });

  it('a never-edited task still reads Created (tie keeps the earlier kind)', () => {
    expect(recentActivityTime(base, 'updated')).toEqual({ at: base.created_at, kind: 'created' });
  });

  it('session activity newer than the last edit wins', () => {
    const t = { ...base, updated_at: '2026-09-01T00:00:00.000Z', last_session_update: '2026-09-10T00:00:00.000Z' };
    expect(recentActivityTime(t, 'updated')).toEqual({ at: '2026-09-10T00:00:00.000Z', kind: 'session' });
  });

  it('completion newest of all → Completed; a later edit of a done task → Updated', () => {
    const done = { ...base, phase: 'COMPLETE' as const, updated_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-09-12T00:00:00.000Z' };
    expect(recentActivityTime(done, 'updated').kind).toBe('completed');
    const byStatus = { ...done, phase: 'TODO' as const, status: 'done' as const };
    expect(recentActivityTime(byStatus, 'updated').kind).toBe('completed');
    const renamedLater = { ...done, updated_at: '2026-09-20T00:00:00.000Z' };
    expect(recentActivityTime(renamedLater, 'updated')).toEqual({ at: '2026-09-20T00:00:00.000Z', kind: 'updated' });
  });

  it('an OPEN task with a stale completed_at (reopened / sync echo) never reads Completed', () => {
    const reopened = { ...base, updated_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-09-12T00:00:00.000Z' };
    expect(recentActivityTime(reopened, 'updated')).toEqual({ at: '2026-09-01T00:00:00.000Z', kind: 'updated' });
  });

  it("'created' mode ignores every other clock", () => {
    const t = { ...base, updated_at: '2026-09-04T08:00:00.000Z', last_session_update: '2026-09-10T00:00:00.000Z', completed_at: '2026-09-12T00:00:00.000Z' };
    expect(recentActivityTime(t, 'created')).toEqual({ at: base.created_at, kind: 'created' });
  });

  it('missing fields never win and an absent created_at yields an empty clock', () => {
    expect(recentActivityTime({ ...base, last_session_update: undefined, completed_at: '' }, 'updated').kind).toBe('created');
    expect(recentActivityTime({ ...base, created_at: undefined as unknown as string, updated_at: undefined as unknown as string }, 'updated')).toEqual({ at: '', kind: 'created' });
  });

  it('sorting by .at matches the historical feed order (latest activity first)', () => {
    const rows = [
      { id: 'edited', ...base, updated_at: '2026-09-04T00:00:00.000Z' },
      { id: 'fresh', ...base, created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z' },
      { id: 'session', ...base, last_session_update: '2026-09-06T00:00:00.000Z' },
      { id: 'stale', ...base },
    ];
    const order = rows.sort((a, b) => recentActivityTime(b, 'updated').at.localeCompare(recentActivityTime(a, 'updated').at)).map((r) => r.id);
    expect(order).toEqual(['session', 'fresh', 'edited', 'stale']);
  });
});

describe('recentActivityTitle', () => {
  it('names the clock and spells the full local date; invalid dates give nothing', () => {
    const at = '2026-09-04T08:00:00.000Z';
    expect(recentActivityTitle({ at, kind: 'updated' })).toBe(`Updated ${new Date(at).toLocaleString()}`);
    expect(recentActivityTitle({ at, kind: 'session' }).startsWith('Session activity ')).toBe(true);
    expect(recentActivityTitle({ at, kind: 'completed' }).startsWith('Completed ')).toBe(true);
    expect(recentActivityTitle({ at: '', kind: 'created' })).toBe('');
  });
});

describe('TodoPanel Recent card wiring (source ratchet)', () => {
  const src = readFileSync(resolve(__dirname, '../../web/src/components/tasks/TodoPanel.tsx'), 'utf8');

  it('the row time and the feed sort both read recentActivityTime', () => {
    expect(src).toMatch(/const activity = recentActivityTime\(task, timeMode\);\s*\n\s*const ago = timeAgo\(activity\.at\);/);
    expect(src).toMatch(/const recentTime = \(t: Task\) => recentActivityTime\(t, recentSortMode\)\.at;/);
    expect(src).toContain('className="todo-recent-ago" title={recentActivityTitle(activity)}');
  });

  it('no row falls back to created_at on its own any more', () => {
    expect(src).not.toContain('task.last_session_update || task.created_at');
  });
});
