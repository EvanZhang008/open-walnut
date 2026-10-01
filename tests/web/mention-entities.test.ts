/**
 * Unit tests for the "@" palette's task ranking (mention-entities.ts): the
 * task row and its run state, the instant local fuzzy layer, how the
 * hybrid-search hits (task hits AND transcript hits) fold into it, and the
 * shared row budget that keeps Tasks and Files visible at once.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '../../src/core/types';
import {
  rankEntities,
  mergeServerHits,
  groupRowBudget,
  taskEntity,
  taskIdOfHit,
  hitsAsTasks,
  type MentionEntity,
} from '../../web/src/components/chat/mention-entities';
import type { EntitySearchHit } from '../../web/src/stores/mention-search';

const task = (over: Partial<MentionEntity>): MentionEntity => ({
  id: 'mt000000-0000',
  title: 'Untitled',
  meta: 'TODO · Inbox',
  active: true,
  state: 'idle',
  recencyKey: '2026-08-01T00:00:00Z',
  ...over,
});

const storeTask = (over: Partial<Task>): Task => ({
  id: 'mt1', title: 'A task', phase: 'IN_PROGRESS', status: 'in_progress', project: 'walnut',
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-02T00:00:00Z', session_ids: [],
  ...over,
} as Task);

const SESSION = '9af9e0b9-1111-2222-3333-444444444444';

describe('taskEntity', () => {
  it('a task that never ran: phase · project, idle', () => {
    const e = taskEntity(storeTask({}));
    expect(e).toMatchObject({ id: 'mt1', title: 'A task', meta: 'IN_PROGRESS · walnut', state: 'idle', live: false, active: true });
  });

  it('a running task: "running" in the meta, a running dot, ranked live', () => {
    const e = taskEntity(storeTask({ session_id: SESSION }), { process_status: 'running' });
    expect(e).toMatchObject({ state: 'running', live: true, meta: 'IN_PROGRESS · walnut · running' });
  });

  it('a task blocked on a permission is "waiting on you", whatever its process status', () => {
    const e = taskEntity(storeTask({ session_id: SESSION }), { process_status: 'idle', pendingPermissionTool: 'Bash' });
    expect(e).toMatchObject({ state: 'waiting', live: true, meta: 'IN_PROGRESS · walnut · waiting on you' });
  });

  it('the live store wins over the enrichment snapshot; without either the snapshot speaks; a stopped task is idle', () => {
    const snap = storeTask({ session_id: SESSION, session_status: { process_status: 'running' } });
    expect(taskEntity(snap, { process_status: 'stopped' })).toMatchObject({ state: 'idle', live: false, meta: 'IN_PROGRESS · walnut' });
    expect(taskEntity(snap, null)).toMatchObject({ state: 'running', live: true });
    expect(taskEntity(storeTask({ session_id: SESSION }), null)).toMatchObject({ state: 'idle', live: false });
  });

  it('Inbox for no project, (untitled) for no title, pinned from pinned or the focus tier, complete is not active', () => {
    expect(taskEntity(storeTask({ project: '', title: '', phase: 'COMPLETE', focus_tier: 'focus' })))
      .toMatchObject({ title: '(untitled)', meta: 'COMPLETE · Inbox', pinned: true, active: false });
  });
});

describe('rankEntities', () => {
  it('empty query: pinned first, then a live session, then active, then most recent', () => {
    const items = [
      task({ id: 'a', title: 'Old done', active: false, recencyKey: '2026-08-20T00:00:00Z' }),
      task({ id: 'b', title: 'Recent active', recencyKey: '2026-08-28T00:00:00Z' }),
      task({ id: 'c', title: 'Pinned but older', pinned: true, recencyKey: '2026-08-10T00:00:00Z' }),
      task({ id: 'd', title: 'Older active', recencyKey: '2026-08-15T00:00:00Z' }),
      task({ id: 'e', title: 'Running, oldest', live: true, recencyKey: '2026-08-05T00:00:00Z' }),
    ];
    expect(rankEntities('', items).map((r) => r.entity.id)).toEqual(['c', 'e', 'b', 'd', 'a']);
    expect(rankEntities('', items)[0]).toMatchObject({ matchField: null, positions: [], source: 'local' });
  });

  it('fuzzy-matches the title with highlight positions and drops non-matches', () => {
    const items = [
      task({ id: 'a', title: 'Fix OAuth callback 401' }),
      task({ id: 'b', title: 'Board refresh storm' }),
    ];
    const ranked = rankEntities('oauth', items);
    expect(ranked.map((r) => r.entity.id)).toEqual(['a']);
    expect(ranked[0].matchField).toBe('title');
    expect(ranked[0].positions).toEqual([4, 5, 6, 7, 8]);
  });

  it('matches the task id too', () => {
    const items: MentionEntity[] = [
      task({ id: 'mtcki5d9-e29d', title: 'Something else' }),
      task({ id: 'mt000000-0000', title: 'Other' }),
    ];
    expect(rankEntities('mtcki', items)[0]).toMatchObject({ matchField: 'id', entity: { id: 'mtcki5d9-e29d' } });
    expect(rankEntities('mtcki', items)).toHaveLength(1);
  });

  it('respects the limit', () => {
    const items = Array.from({ length: 20 }, (_, i) => task({ id: `t${i}`, title: `auth task ${i}` }));
    expect(rankEntities('auth', items, { limit: 3 })).toHaveLength(3);
    expect(rankEntities('', items, { limit: 5 })).toHaveLength(5);
  });
});

describe('taskIdOfHit / hitsAsTasks', () => {
  const taskHit = (id: string, title: string, over: Partial<EntitySearchHit> = {}): EntitySearchHit =>
    ({ type: 'task', id, title, summary: `${title} summary`, phase: 'IN_PROGRESS', project: 'walnut', ref: `<task-ref id="${id}" label="${title}"/>`, ...over });
  // The slim contract: a session row's `id` is its OWNING task, the ref names the session.
  const sessionHit = (owner: string, sid: string, title: string): EntitySearchHit =>
    ({ type: 'session', id: owner, title, summary: 'transcript snippet', phase: 'IN_PROGRESS', project: 'walnut', ref: `<session-ref id="${sid}" label="${title}"/>` });

  it('a task hit is its own id; a transcript hit is its task; a transcript with no task is nothing', () => {
    expect(taskIdOfHit(taskHit('mt1', 'T'))).toBe('mt1');
    expect(taskIdOfHit(sessionHit('mt1', SESSION, 'S'))).toBe('mt1');
    expect(taskIdOfHit(sessionHit(SESSION, SESSION, 'orphan'))).toBeNull();
    expect(taskIdOfHit({ type: 'memory', id: '/notes/x.md', title: 'x', summary: '' })).toBeNull();
  });

  it('folds a task hit and its transcript hit into ONE row at the first position, borrowing the local row\'s live state', () => {
    const local = new Map<string, MentionEntity>([
      ['mt1', task({ id: 'mt1', title: 'Local title', meta: 'IN_PROGRESS · walnut · running', state: 'running', live: true })],
    ]);
    const hits = [sessionHit('mt1', SESSION, 'Session title'), taskHit('mt2', 'Second'), taskHit('mt1', 'Local title')];
    const out = hitsAsTasks(hits, local);
    expect(out.map((e) => e.id)).toEqual(['mt1', 'mt2']);
    expect(out[0]).toMatchObject({ title: 'Local title', state: 'running', live: true, summary: 'transcript snippet' });
    expect(out[1]).toMatchObject({ title: 'Second', meta: 'IN_PROGRESS · walnut', active: true, state: 'idle', summary: 'Second summary' });
  });

  it('a transcript hit on a task the browser does not hold still becomes that task\'s row, named by the later task hit', () => {
    const out = hitsAsTasks([sessionHit('mt9', SESSION, 'Old session name'), taskHit('mt9', 'Real task title', { phase: 'TODO', project: '' })], new Map());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'mt9', title: 'Real task title', meta: 'TODO · Inbox', summary: 'transcript snippet' });
  });

  it('drops transcripts with no task and the caller\'s own task, by task hit or by its transcript', () => {
    const out = hitsAsTasks(
      [sessionHit(SESSION, SESSION, 'no task'), taskHit('self', 'Me'), sessionHit('self', 'self-sid', 'My transcript'), taskHit('mt2', 'Peer')],
      new Map(),
      'self',
    );
    expect(out.map((e) => e.id)).toEqual(['mt2']);
  });
});

describe('mergeServerHits', () => {
  const local = rankEntities('login', [
    task({ id: 'kw', title: 'Login page flicker' }),
    task({ id: 'kw2', title: 'Login button copy' }),
  ]);

  it('bands: agreed rows first (local order), then server-only, then local-only', () => {
    const server: MentionEntity[] = [
      task({ id: 'sem', title: 'Fix OAuth callback 401', summary: 'callback returns 401 after code exchange' }),
      task({ id: 'kw', title: 'Login page flicker' }),
    ];
    const merged = mergeServerHits('login', local, server);
    expect(merged.map((r) => r.entity.id)).toEqual(['kw', 'sem', 'kw2']);
    // Present on both sides: keeps the local positions, marked 'both'.
    expect(merged[0].source).toBe('both');
    expect(merged[0].positions).toEqual(local[0].positions);
    // Purely semantic hit: nothing to highlight, summary explains it.
    expect(merged[1]).toMatchObject({ source: 'server', positions: [], matchField: null });
    expect(merged[1].entity.summary).toContain('401');
    expect(merged[2].source).toBe('local');
  });

  it('a server re-rank never pushes the exact local match out of a 2-row budget', () => {
    const exact = rankEntities('walnut oauth', [task({ id: 'x', title: 'Walnut OAuth callback 401' })]);
    const server: MentionEntity[] = [
      task({ id: 's1', title: 'Walnut calendar view' }),
      task({ id: 's2', title: 'Walnut commit split' }),
      task({ id: 'x', title: 'Walnut OAuth callback 401' }),
    ];
    expect(mergeServerHits('walnut oauth', exact, server).slice(0, 2).map((r) => r.entity.id)).toEqual(['x', 's1']);
  });

  it('a keyword-style server hit still gets highlight positions from its title', () => {
    const merged = mergeServerHits('login', [], [task({ id: 'x', title: 'Social login providers' })]);
    expect(merged[0].matchField).toBe('title');
    expect(merged[0].positions).toEqual([7, 8, 9, 10, 11]);
  });

  it('no server hits → local list untouched; duplicate server rows collapse', () => {
    expect(mergeServerHits('login', local, [])).toBe(local);
    const dup = task({ id: 'd', title: 'Login dup' });
    expect(mergeServerHits('login', [], [dup, dup])).toHaveLength(1);
  });
});

describe('groupRowBudget', () => {
  it('one group takes the whole panel; Tasks and Files together share it so both stay visible', () => {
    expect(groupRowBudget(0)).toEqual({ entity: 12, files: 12 });
    expect(groupRowBudget(1)).toEqual({ entity: 12, files: 12 });
    expect(groupRowBudget(2)).toEqual({ entity: 5, files: 5 });
  });
});
