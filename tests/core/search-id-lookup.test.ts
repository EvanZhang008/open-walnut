/**
 * The id lane: pasting a task/session id must resolve to that exact record,
 * instantly, WITHOUT the ranking legs — the hybrid index carries prose, not
 * opaque ids, so consulting it for an id query only costs an embedder warm and
 * invites unrelated high-similarity content to surround the answer.
 *
 * The `searchV2Lane` spy is the load-bearing assertion in the search() blocks:
 * "was the semantic leg consulted at all?" is the difference between a lookup
 * and a relevance question.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MIN_ID_QUERY_LENGTH,
  matchIdQuery,
  parseIdQuery,
  unwrapIdReference,
} from '../../src/core/search/id-lookup.js';
import type { SessionRecord, Task } from '../../src/core/types.js';

function makeTask(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id, title, category: 'Inbox', project: '', priority: 'none',
    status: 'todo', phase: 'TODO', source: 'local',
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    ...extra,
  } as Task;
}

// Two tasks created inside the same 1,296 ms window share a 6-char prefix but
// not the 8-char one — the ambiguity case the lane must not guess at.
const TASK_A = makeTask('mtjp1nzl-d230', 'Rich HTML streaming output mode');
const TASK_B = makeTask('mtjp1nxx-9a11', 'Sibling created a second later');
const TASK_OWNER = makeTask('mtabcd12-0001', 'Task that owns a session');
const TASKS = [TASK_A, TASK_B, TASK_OWNER];

const SESSION_OWNED = {
  claudeSessionId: 'fa11ce00-2222-3333-4444-555555555555',
  taskId: TASK_OWNER.id,
  title: 'Owned session',
} as SessionRecord;
const SESSION_ORPHAN = {
  claudeSessionId: 'beef1234-9999-8888-7777-666666666666',
  title: 'Orphan session',
} as SessionRecord;
const SESSIONS = [SESSION_OWNED, SESSION_ORPHAN];

describe('parseIdQuery — what counts as an id query', () => {
  it('accepts a whole task id and flags it as whole', () => {
    expect(parseIdQuery('mtjp1nzl-d230')).toEqual({
      needle: 'mtjp1nzl-d230', wholeTaskId: true, sessionShaped: false,
    });
  });

  it('flags only hex-and-dash needles as session-shaped', () => {
    // Gates the session-store read: a long single word passes the length gate
    // ('typescript'), and paying for a session list it cannot match is waste.
    expect(parseIdQuery('fa11ce00-2222-3333-4444-555555555555')?.sessionShaped).toBe(true);
    expect(parseIdQuery('mtjp1nzl-d230')?.sessionShaped).toBe(false);
    expect(parseIdQuery('typescript')?.sessionShaped).toBe(false);
  });

  it('is case insensitive (ids get pasted from logs and prose)', () => {
    expect(parseIdQuery('MTJP1NZL-D230')?.needle).toBe('mtjp1nzl-d230');
  });

  it('accepts a uuid session id', () => {
    expect(parseIdQuery('fa11ce00-2222-3333-4444-555555555555')?.needle)
      .toBe('fa11ce00-2222-3333-4444-555555555555');
  });

  it('accepts an 8-char pure-alpha prefix (the whole base36 millisecond clock)', () => {
    expect(parseIdQuery('mtjpcnzl')?.wholeTaskId).toBe(false);
  });

  it('accepts a 6-char prefix when a digit or dash proves it opaque', () => {
    expect(parseIdQuery('mtjpc1')).not.toBeNull();
    expect(parseIdQuery('mtjpc-')).toBeNull(); // trailing dash is not an id
    expect(parseIdQuery('mt1-9x')).not.toBeNull();
  });

  it('rejects a 6-7 letter word that could be prose', () => {
    // Words made of base36 letters are real ("facade", "decade", "results").
    // The lane short-circuits, so a false positive DELETES the right answers.
    expect(parseIdQuery('facade')).toBeNull();
    expect(parseIdQuery('decade')).toBeNull();
    expect(parseIdQuery('results')).toBeNull();
  });

  it('rejects anything shorter than the identifier floor', () => {
    expect(MIN_ID_QUERY_LENGTH).toBe(6);
    expect(parseIdQuery('mtjp1')).toBeNull();
    expect(parseIdQuery('mt-1')).toBeNull();
  });

  it('rejects multi-word queries and prose containing an id', () => {
    expect(parseIdQuery('why did mtjp1nzl-d230 fail')).toBeNull();
    expect(parseIdQuery('rich html streaming')).toBeNull();
  });

  it('rejects ids wearing characters that are not base36 or dash', () => {
    expect(parseIdQuery('mtjpcnzl_d230')).toBeNull();
    expect(parseIdQuery('https://example.test/mtjp1nzl-d230')).toBeNull();
  });
});

describe('unwrapIdReference — an id in the wild arrives decorated', () => {
  it.each([
    ['`mtjp1nzl-d230`', 'mtjp1nzl-d230'],
    ['"mtjp1nzl-d230"', 'mtjp1nzl-d230'],
    ['(mtjp1nzl-d230)', 'mtjp1nzl-d230'],
    ['[mtjp1nzl-d230]', 'mtjp1nzl-d230'],
    ['mtjp1nzl-d230.', 'mtjp1nzl-d230'],
    ['mtjp1nzl-d230:', 'mtjp1nzl-d230'],
    ['#mtjp1nzl-d230', 'mtjp1nzl-d230'],
    ['`mtjp1nzl-d230`.', 'mtjp1nzl-d230'],
    ['  ("mtjp1nzl-d230"),  ', 'mtjp1nzl-d230'],
  ])('%s → %s', (raw, want) => {
    expect(unwrapIdReference(raw)).toBe(want);
    expect(parseIdQuery(raw)?.needle).toBe(want);
  });

  it('unwrapping cannot launder prose into an id', () => {
    // Shape validation runs AFTER unwrapping, so stripping decoration can only
    // ever reveal an id — never manufacture one.
    expect(parseIdQuery('"the rich html streaming task"')).toBeNull();
    expect(parseIdQuery('`a b`')).toBeNull();
  });
});

describe('matchIdQuery — ambiguity is answered with all matches', () => {
  it('a whole id resolves to exactly that task', () => {
    const matches = matchIdQuery(parseIdQuery('mtjp1nzl-d230')!, { tasks: TASKS });
    expect(matches).toHaveLength(1);
    expect(matches[0].task?.id).toBe(TASK_A.id);
    expect(matches[0].score).toBe(1);
  });

  it('an unambiguous prefix resolves to one task', () => {
    const matches = matchIdQuery(parseIdQuery('mtjp1nz')!, { tasks: TASKS });
    expect(matches.map((m) => m.task?.id)).toEqual([TASK_A.id]);
    expect(matches[0].score).toBe(0.99);
  });

  it('an AMBIGUOUS prefix returns every match, newest first', () => {
    // 'mtjp1n' is the 6-char base36-clock prefix both siblings were created in.
    const matches = matchIdQuery(parseIdQuery('mtjp1n')!, { tasks: TASKS });
    // Newest first: task ids sort chronologically as strings.
    expect(matches.map((m) => m.task?.id)).toEqual([TASK_A.id, TASK_B.id]);
    expect(matches.every((m) => m.score === 0.99)).toBe(true);
  });

  it('an exact match suppresses prefix matches of the same needle', () => {
    const prefixOfAnother = makeTask('mtjp1nzl-d2300000', 'Longer id sharing the whole short id');
    const matches = matchIdQuery(parseIdQuery('mtjp1nzl-d230')!, {
      tasks: [...TASKS, prefixOfAnother],
    });
    expect(matches.map((m) => m.task?.id)).toEqual([TASK_A.id]);
  });

  it('a session id matches through the session record', () => {
    const matches = matchIdQuery(parseIdQuery('fa11ce00-2222-3333-4444-555555555555')!, {
      sessions: SESSIONS,
    });
    expect(matches[0].session?.claudeSessionId).toBe(SESSION_OWNED.claudeSessionId);
    expect(matches[0].matchField).toBe('session_id');
  });

  it('an 8-char session-id prefix matches (that is what the UI displays)', () => {
    const matches = matchIdQuery(parseIdQuery('fa11ce00')!, { sessions: SESSIONS });
    expect(matches.map((m) => m.session?.claudeSessionId)).toEqual([SESSION_OWNED.claudeSessionId]);
  });
});

// ── search() integration: the leg must short-circuit ahead of the semantic leg ──

let laneCalls: string[] = [];

async function loadSearchWithSpies() {
  laneCalls = [];
  vi.doMock('../../src/core/task-manager.js', () => ({
    listTasks: vi.fn().mockResolvedValue(TASKS),
  }));
  vi.doMock('../../src/core/session-tracker.js', () => ({
    listSessions: vi.fn().mockResolvedValue(SESSIONS),
  }));
  vi.doMock('../../src/core/search/wiring.js', () => ({
    searchV2Lane: vi.fn(async (q: string) => { laneCalls.push(q); return []; }),
  }));
  vi.doMock('../../src/lib/hybrid-search/index.js', () => ({
    setQuerySegmentObserver: vi.fn(),
  }));
  return (await import('../../src/core/search.js')).search;
}

describe('search() id lane', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a whole task id returns that task and NEVER consults the semantic leg', async () => {
    const search = await loadSearchWithSpies();
    const results = await search('mtjp1nzl-d230');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'task', taskId: TASK_A.id, matchField: 'id', score: 1 });
    expect(laneCalls).toEqual([]);
  });

  it('a DECORATED id resolves the same way (it used to return semantic noise)', async () => {
    const search = await loadSearchWithSpies();
    for (const decorated of ['`mtjp1nzl-d230`', '(mtjp1nzl-d230)', 'mtjp1nzl-d230.']) {
      const results = await search(decorated);
      expect(results.map((r) => r.taskId), decorated).toEqual([TASK_A.id]);
      expect(laneCalls, decorated).toEqual([]);
    }
  });

  it('an id PREFIX short-circuits too (it used to pay the full hybrid cost)', async () => {
    const search = await loadSearchWithSpies();
    const results = await search('mtjp1nzl');
    expect(results.map((r) => r.taskId)).toEqual([TASK_A.id]);
    expect(laneCalls).toEqual([]);
  });

  it('an ambiguous prefix returns BOTH tasks rather than guessing one', async () => {
    const search = await loadSearchWithSpies();
    const results = await search('mtjp1n');
    expect(results.map((r) => r.taskId)).toEqual([TASK_A.id, TASK_B.id]);
    expect(laneCalls).toEqual([]);
  });

  it('a session id resolves to its owning task, no semantic leg', async () => {
    const search = await loadSearchWithSpies();
    const results = await search('fa11ce00-2222-3333-4444-555555555555');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'task', taskId: TASK_OWNER.id, sessionId: SESSION_OWNED.claudeSessionId,
      matchField: 'session_id',
    });
    expect(laneCalls).toEqual([]);
  });

  it('an ownerless session id resolves to the session row itself', async () => {
    const search = await loadSearchWithSpies();
    const results = await search('beef1234-9999-8888-7777-666666666666');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'session', sessionId: SESSION_ORPHAN.claudeSessionId, matchField: 'session_id',
    });
    expect(laneCalls).toEqual([]);
  });

  it('an id-shaped MISS falls through to the ranked legs instead of returning empty', async () => {
    const search = await loadSearchWithSpies();
    const results = await search('zzzzzz99-0000');
    expect(results).toEqual([]);
    // The point: the ranking legs still ran, so a real content match would show.
    expect(laneCalls.length).toBeGreaterThan(0);
  });

  it('an ordinary prose query is untouched by the lane', async () => {
    const search = await loadSearchWithSpies();
    await search('rich html streaming output');
    expect(laneCalls.length).toBeGreaterThan(0);
  });

  it('a long single word that only LOOKS opaque costs no store read', async () => {
    // 'typescript' clears the length gate but is not hex, so the session store
    // is never touched, and no task id can start with it — the lane is inert.
    const listSessions = vi.fn().mockResolvedValue(SESSIONS);
    vi.doMock('../../src/core/task-manager.js', () => ({
      listTasks: vi.fn().mockResolvedValue(TASKS),
    }));
    vi.doMock('../../src/core/session-tracker.js', () => ({ listSessions }));
    vi.doMock('../../src/core/search/wiring.js', () => ({
      searchV2Lane: vi.fn(async () => []),
    }));
    vi.doMock('../../src/lib/hybrid-search/index.js', () => ({
      setQuerySegmentObserver: vi.fn(),
    }));
    const { search } = await import('../../src/core/search.js');
    await search('typescript', { types: ['memory'] });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('types=[session] does not return a task row for a task id', async () => {
    const search = await loadSearchWithSpies();
    const results = await search('mtjp1nzl-d230', { types: ['session'] });
    expect(results.filter((r) => r.type === 'task')).toEqual([]);
  });
});
