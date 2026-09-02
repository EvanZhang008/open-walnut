import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  scoreMatch,
  extractSnippet,
  searchSessionReferences,
  searchSessionTaskReferences,
  searchTaskReferences,
} from '../../src/core/search.js';
import type { SessionRecord, Task } from '../../src/core/types.js';

describe('scoreMatch', () => {
  it('returns 0 for empty query', () => {
    expect(scoreMatch('some text', '', 1)).toBe(0);
  });

  it('returns 0 when no terms match', () => {
    expect(scoreMatch('hello world', 'xyz', 1)).toBe(0);
  });

  it('scores a simple match', () => {
    const score = scoreMatch('hello world', 'hello', 1);
    expect(score).toBeGreaterThan(0);
  });

  it('gives bonus for word boundary matches', () => {
    // "hello" as a whole word gets a bonus
    const exactScore = scoreMatch('say hello please', 'hello', 1);
    // "hell" is a substring but not a word boundary match in "hello"
    const partialScore = scoreMatch('say hello please', 'hell', 1);
    // Both should score, but exact word should score higher
    expect(exactScore).toBeGreaterThan(partialScore);
  });

  it('scores multiple terms', () => {
    const singleScore = scoreMatch('hello world foo', 'hello', 2);
    const multiScore = scoreMatch('hello world foo', 'hello world', 2);
    expect(multiScore).toBeGreaterThan(singleScore);
  });

  it('is case insensitive', () => {
    const score = scoreMatch('Hello World', 'hello', 1);
    expect(score).toBeGreaterThan(0);
  });

  it('respects weight parameter', () => {
    const low = scoreMatch('hello', 'hello', 1);
    const high = scoreMatch('hello', 'hello', 5);
    expect(high).toBeGreaterThan(low);
  });
});

describe('extractSnippet', () => {
  it('returns snippet around matched term', () => {
    const content = 'The quick brown fox jumps over the lazy dog';
    const snippet = extractSnippet(content, 'fox', 10);
    expect(snippet).toContain('fox');
  });

  it('adds ellipsis when snippet is in the middle', () => {
    const content = 'A'.repeat(50) + ' hello world ' + 'B'.repeat(50);
    const snippet = extractSnippet(content, 'hello', 10);
    expect(snippet).toContain('...');
    expect(snippet).toContain('hello');
  });

  it('handles no match - returns beginning of content', () => {
    const content = 'Short text here';
    const snippet = extractSnippet(content, 'nonexistent', 40);
    expect(snippet).toBe('Short text here');
  });

  it('truncates long content when no match found', () => {
    const content = 'A'.repeat(200);
    const snippet = extractSnippet(content, 'nonexistent', 20);
    expect(snippet.length).toBeLessThan(200);
    expect(snippet).toContain('...');
  });

  it('handles empty content', () => {
    const snippet = extractSnippet('', 'query', 40);
    expect(snippet).toBe('');
  });

  it('handles multi-word queries', () => {
    const content = 'The task is to review the pull request';
    const snippet = extractSnippet(content, 'review pull', 20);
    expect(snippet).toContain('review');
  });

  it('replaces newlines with spaces', () => {
    const content = 'Line one\nLine two\nLine three';
    const snippet = extractSnippet(content, 'two', 40);
    expect(snippet).not.toContain('\n');
  });
});

describe('searchTaskReferences', () => {
  const sessionId = '12345678-1234-4abc-8def-1234567890ab';
  const baseTask = {
    id: 'task-reference-target',
    title: 'Reference target',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    project: 'Quick Start',
    source: 'local',
    session_id: 'legacy-session-reference',
    session_ids: [sessionId],
    plan_session_id: 'plan-session-reference',
    exec_session_id: 'exec-session-reference',
    external_url: 'https://example.test/tasks/reference-target',
    description: '',
    summary: '',
    note: '',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as Task;

  it('returns an exact session ID as a top-scored keyword result', () => {
    expect(searchTaskReferences([baseTask], sessionId)).toEqual([
      expect.objectContaining({
        taskId: baseTask.id,
        matchField: 'session_id',
        score: 1,
      }),
    ]);
  });

  it('supports a meaningful session ID substring but ignores short noise', () => {
    expect(searchTaskReferences([baseTask], '12345678')[0]?.taskId).toBe(baseTask.id);
    expect(searchTaskReferences([baseTask], '1234')).toEqual([]);
  });

  it('does not treat a natural-language URL slug as an opaque reference', () => {
    const taskWithReadableUrl = {
      ...baseTask,
      external_url: 'https://example.test/tasks/deployment-review',
    };

    expect(searchTaskReferences([taskWithReadableUrl], 'deployment')).toEqual([]);
  });

  it.each([
    [baseTask.id, 'id'],
    ['task-ref', 'id'],
    [baseTask.session_id, 'session_id'],
    [baseTask.plan_session_id, 'session_id'],
    [baseTask.exec_session_id, 'session_id'],
    [baseTask.external_url, 'external_url'],
  ] as const)('resolves structured reference %s from %s', (query, matchField) => {
    expect(searchTaskReferences([baseTask], query)[0]).toEqual(
      expect.objectContaining({
        taskId: baseTask.id,
        matchField,
      }),
    );
  });
});

describe('searchSessionReferences', () => {
  const sessionId = '12345678-1234-4abc-8def-1234567890ab';
  const session = {
    claudeSessionId: sessionId,
    title: 'Reference session',
  } as SessionRecord;

  it('resolves exact and meaningful partial session IDs without the index', () => {
    expect(searchSessionReferences([session], sessionId)[0]).toEqual(
      expect.objectContaining({
        sessionId,
        matchField: 'session_id',
        score: 1,
      }),
    );
    expect(searchSessionReferences([session], '12345678')[0]?.sessionId).toBe(sessionId);
    expect(searchSessionReferences([session], '1234')).toEqual([]);
  });

  it('session hits carry the owning taskId ("which TASK did X?" is one hop)', () => {
    // 2026-08-16 eval: an agent searching types=session found the right session
    // but could not name the task, because the hit omitted taskId even though
    // SessionRecord.taskId was right there.
    const owned = {
      claudeSessionId: sessionId,
      title: 'Owned session',
      taskId: 'task-owner-1',
      commitShas: ['a00ee84c'],
    } as SessionRecord;
    expect(searchSessionReferences([owned], sessionId)[0]?.taskId).toBe('task-owner-1');
    expect(searchSessionReferences([owned], 'a00ee84c')[0]?.taskId).toBe('task-owner-1');
  });

  it('resolves a commit SHA to its producing session (commit_sha lane)', () => {
    const committer = {
      claudeSessionId: sessionId,
      title: 'Star removal session',
      commitShas: ['68e23b9e', 'a00ee84c'],
    } as SessionRecord;
    // Short SHA exact hit
    expect(searchSessionReferences([committer], 'a00ee84c')[0]).toEqual(
      expect.objectContaining({ sessionId, matchField: 'commit_sha', score: 1 }),
    );
    // Full-SHA query vs short stored SHA (prefix, hex-only)
    expect(searchSessionReferences([committer], 'a00ee84c1234567890abcdef1234567890abcdef')[0]?.matchField)
      .toBe('commit_sha');
    // Non-hex lookalike must not match
    expect(searchSessionReferences([committer], 'a00ee84cz')).toEqual([]);
  });
});

describe('searchSessionTaskReferences', () => {
  const sessionId = '87654321-1234-4abc-8def-1234567890ab';
  const task = {
    id: 'task-owned-by-session-record',
    title: 'Session-owned task',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    project: 'Quick Start',
    source: 'local',
    session_ids: [],
  } as Task;

  it('joins SessionRecord.taskId when the task has no session link fields', () => {
    const results = searchSessionTaskReferences([task], [{
      claudeSessionId: sessionId,
      taskId: task.id,
      title: 'Codex session',
    } as SessionRecord], sessionId);

    expect(results).toEqual([
      expect.objectContaining({
        type: 'task',
        taskId: task.id,
        sessionId,
        matchField: 'session_id',
        score: 1,
      }),
    ]);
  });

  it('ignores dangling SessionRecord.taskId values', () => {
    expect(searchSessionTaskReferences([task], [{
      claudeSessionId: sessionId,
      taskId: 'deleted-task',
    } as SessionRecord], sessionId)).toEqual([]);
  });

  it('resolves a commit SHA to the owning TASK ("which task made commit X?")', () => {
    const results = searchSessionTaskReferences([task], [{
      claudeSessionId: sessionId,
      taskId: task.id,
      title: 'Star removal session',
      commitShas: ['a00ee84c'],
    } as SessionRecord], 'a00ee84c');

    expect(results).toEqual([
      expect.objectContaining({
        type: 'task',
        taskId: task.id,
        sessionId,
        matchField: 'commit_sha',
        score: 1,
      }),
    ]);
  });
});

/** One hit as `searchV2Lane` returns it. `components.coverage` is the
 *  whole-document query-term fraction the cross-lane coverage tiebreak reads. */
function laneHit(over: Record<string, unknown>) {
  return {
    kind: 'memory',
    ref: 'memory/a.md',
    title: '',
    text: '',
    score: 0.5,
    components: { coverage: 1, cosine: 0 },
    semantic: 'off',
    ...over,
  };
}

/** Mock the index lane, answering per requested kind set. */
function mockLane(byKinds: (kinds: string[] | undefined) => unknown[]) {
  const lane = vi.fn(async (_q: string, opts?: { kinds?: string[] }) => byKinds(opts?.kinds));
  vi.doMock('../../src/core/search/wiring.js', () => ({ searchV2Lane: lane }));
  return lane;
}

/** Empty stores: these tests exercise the merge, not the task/session files. */
function mockEmptyStores() {
  vi.doMock('../../src/core/task-manager.js', () => ({
    listTasks: vi.fn().mockResolvedValue([]),
  }));
  vi.doMock('../../src/core/session-tracker.js', () => ({
    listSessions: vi.fn().mockResolvedValue([]),
  }));
}

describe('index memory search integration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/core/search/wiring.js');
  });

  it('search() maps hits from the index memory lane', async () => {
    const lane = mockLane(() => [
      laneHit({
        ref: 'memory/notes.md',
        title: 'TypeScript patterns',
        text: 'Some content about TypeScript patterns',
        score: 0.9,
      }),
      laneHit({
        ref: 'memory/other.md',
        title: 'More TypeScript',
        text: 'Another chunk about TypeScript',
        score: 0.7,
      }),
    ]);

    const { search } = await import('../../src/core/search.js');
    const results = await search('TypeScript', { types: ['memory'] });

    expect(results.length).toBe(2);
    expect(results[0].type).toBe('memory');
    // matchField carries the index kind so callers can tell the file-backed
    // universes apart (memory / note / skill).
    expect(results[0].matchField).toBe('memory');
    expect(results[0].path).toBe('memory/notes.md');
    // The whole file-backed universe rides ONE lane call.
    expect(lane).toHaveBeenCalledWith('TypeScript', {
      kinds: ['memory', 'note', 'skill'],
      limit: 20,
    });
  });

  it('bounds hit snippets so one search cannot flood a caller with transcript', async () => {
    // Measured 2026-08-16 during the real MCP-vs-CLI A/B: THREE session hits
    // carried 9,831 chars (~2.5K tokens) of raw turn-by-turn transcript, because
    // the lane of the day passed the whole matched chunk through. An agent spent
    // its context on it; the hardest eval task was dominated by that payload.
    // Every lane now snippets the raw doc text itself (extractSnippet), so the
    // caller-visible payload stays a preview no matter how big the document is.
    const hugeChunk = 'Turn 41 ran a command\n'.repeat(400); // ~8.8K chars
    mockEmptyStores();
    mockLane((kinds) => kinds?.includes('session')
      ? [laneHit({ kind: 'session', ref: 'abc', title: 'huge session', text: hugeChunk, score: 0.9 })]
      : [laneHit({ ref: 'memory/m.md', title: 'huge memory', text: hugeChunk, score: 0.8 })]);

    const { search } = await import('../../src/core/search.js');
    const results = await search('command', { types: ['memory', 'session'] });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.snippet.length).toBeLessThanOrEqual(200);
    }
    // Still a usable preview, and collapsed to one line (no raw newlines).
    expect(results[0].snippet).toContain('Turn 41');
    expect(results[0].snippet).not.toContain('\n');
  });

  it('surfaces a total index-lane failure instead of returning an authoritative empty set', async () => {
    mockLane(() => { throw new Error('Database not available'); });

    const { search } = await import('../../src/core/search.js');
    await expect(search('TypeScript', { types: ['memory'] }))
      .rejects.toThrow('Database not available');
  });

  it('mixed CJK/Latin query: full-term-coverage hit outranks a higher-scored partial hit', async () => {
    // The task and memory lanes score on their own scales, so a memory doc
    // matching ONLY "timeout" can out-score a task matching BOTH terms.
    // Coverage must win the cross-lane merge for mixed queries.
    mockEmptyStores();
    mockLane((kinds) => kinds?.includes('task')
      ? [laneHit({
        kind: 'task', ref: 't1',
        title: '请求 timeout 频发 — 查能否自动重试',
        text: '让 daemon 自动重试 timeout 的请求',
        score: 0.5,
        components: { coverage: 1, cosine: 0 }, // both terms
      })]
      : [laneHit({
        ref: 'memory/triage.md',
        title: 'triage memory',
        text: 'unrelated doc that only mentions timeout once',
        score: 1.1,
        components: { coverage: 0.5, cosine: 0 }, // one of two terms
      })]);

    const { search } = await import('../../src/core/search.js');
    const results = await search('timeout 自动重试', { types: ['task', 'memory'] });

    expect(results[0].taskId).toBe('t1');
    expect(results[1].title).toBe('triage memory');
  });

  it('pure-Latin multi-term query: coverage outranks a higher-scored partial hit', async () => {
    // Coverage ranking was CJK-only at first; the 2026-08-20 eval showed the
    // same cross-lane score incomparability buries English paraphrase hits, so
    // the tiebreak now applies to every multi-term query.
    mockEmptyStores();
    mockLane((kinds) => kinds?.includes('task')
      ? [laneHit({
        kind: 'task', ref: 't1', title: 'timeout retry task',
        text: 'covers timeout and retry', score: 0.5,
        components: { coverage: 1, cosine: 0 },
      })]
      : [laneHit({
        ref: 'memory/m.md', title: 'timeout-only doc',
        text: 'only timeout here', score: 1.1,
        components: { coverage: 0.5, cosine: 0 },
      })]);

    const { search } = await import('../../src/core/search.js');
    const results = await search('timeout retry', { types: ['task', 'memory'] });

    expect(results[0].title).toBe('timeout retry task');
    expect(results[1].title).toBe('timeout-only doc');
  });

  it('grab-bag sources get their coverage bucket halved in the merge', async () => {
    // Skill docs (reference manuals) mention almost any term combination
    // somewhere, so full coverage from them is base rate, not signal.
    mockEmptyStores();
    mockLane((kinds) => kinds?.includes('task')
      ? [laneHit({
        kind: 'task', ref: 't1', title: 'timeout retry task',
        text: 'covers timeout and retry', score: 0.5,
        components: { coverage: 1, cosine: 0 },
      })]
      : [laneHit({
        kind: 'skill', ref: 'skills/ops/SKILL.md', title: 'Ops manual',
        text: 'timeout somewhere, retry elsewhere', score: 1.3,
        components: { coverage: 1, cosine: 0 },
      })]);

    const { search } = await import('../../src/core/search.js');
    const results = await search('timeout retry', { types: ['task', 'memory'] });

    // Both cover 2/2, but the skill doc is a grab-bag source: its bucket is
    // halved, so the focused task doc wins despite the lower raw score.
    expect(results[0].title).toBe('timeout retry task');
  });
});

describe('default search lanes (2026-08-15 star incident)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/core/search/wiring.js');
    vi.doUnmock('../../src/core/task-manager.js');
    vi.doUnmock('../../src/core/session-tracker.js');
  });

  it('DEFAULT_SEARCH_TYPES includes sessions', async () => {
    const { DEFAULT_SEARCH_TYPES } = await import('../../src/core/search.js');
    // Transcripts are the ground truth for "which task changed X" — a default
    // that skips the session index made real work unfindable. Regression guard.
    expect([...DEFAULT_SEARCH_TYPES].sort()).toEqual(['memory', 'session', 'task']);
  });

  it('search() with NO types option consults the session lane and returns its hits', async () => {
    mockEmptyStores();
    const lane = mockLane((kinds) => kinds?.includes('session')
      ? [laneHit({
        kind: 'session', ref: '8df36131', title: 'star removal session',
        text: 'retire the star system — StarButton deleted', score: 0.9,
      })]
      : []);

    const { search } = await import('../../src/core/search.js');
    const results = await search('StarButton'); // deliberately NO types option

    const sessionLaneQueried = lane.mock.calls.some(
      (c) => (c[1] as { kinds?: string[] } | undefined)?.kinds?.includes('session') === true,
    );
    expect(sessionLaneQueried).toBe(true);
    expect(results.some((r) => r.type === 'session' && r.sessionId === '8df36131')).toBe(true);
  });
});

describe('titleMatchScore — title-paraphrase lane (2026-08-20 eval)', () => {
  it('scores a synonym-swapped title paraphrase', async () => {
    const { titleMatchScore } = await import('../../src/core/search.js');
    // "update behavior" remembered as "upgrade handling" — 4 of 6 content
    // terms still hit the title.
    const s = titleMatchScore('Helm CRD update behavior in CDK', 'Helm chart CRD upgrade handling in CDK');
    expect(s).toBeGreaterThan(0.7);
  });

  it('cross-language: English query matches the Latin tokens of a Chinese title', async () => {
    const { titleMatchScore } = await import('../../src/core/search.js');
    const s = titleMatchScore('云端Walnut迁移架构调查+设计(plan)', 'cloud walnut migration architecture plan');
    expect(s).toBeGreaterThan(0.7);
  });

  it('rejects two common words scattered in a long unrelated title', async () => {
    const { titleMatchScore } = await import('../../src/core/search.js');
    const s = titleMatchScore(
      'Investigate the task list rendering system and plan a fix for the dropdown regression',
      'cloud walnut migration architecture plan',
    );
    expect(s).toBe(0);
  });

  it('single-term queries never fire the lane', async () => {
    const { titleMatchScore } = await import('../../src/core/search.js');
    expect(titleMatchScore('walnut anything', 'walnut')).toBe(0);
  });

  it('stopword glue in agent phrasing does not dilute the match', async () => {
    const { titleMatchScore } = await import('../../src/core/search.js');
    const glued = titleMatchScore('Star system removal', 'which task removed the star system from tasks');
    expect(glued).toBeGreaterThan(0);
  });
});

describe('termInText — word-boundary + stem-flex containment', () => {
  it('rejects substring-only hits (star vs starve/start)', async () => {
    const { termInText } = await import('../../src/core/cjk.js');
    expect(termInText("don't starve", 'star')).toBe(false);
    expect(termInText('quick start guide', 'star')).toBe(false);
    expect(termInText('the star system', 'star')).toBe(true);
  });

  it('matches morphological variants of long terms', async () => {
    const { termInText } = await import('../../src/core/cjk.js');
    expect(termInText('two conversations later', 'conversation')).toBe(true);
    expect(termInText('the removal of the button', 'removed')).toBe(true);
    expect(termInText('investigate the alarm', 'investigation')).toBe(true);
  });

  it('treats an adjacent CJK ideograph as a word boundary', async () => {
    const { termInText } = await import('../../src/core/cjk.js');
    expect(termInText('云端walnut迁移架构', 'walnut')).toBe(true);
  });

  it('CJK terms keep substring semantics', async () => {
    const { termInText } = await import('../../src/core/cjk.js');
    expect(termInText('排查任务日期自动建议错位问题', '日期')).toBe(true);
  });
});
