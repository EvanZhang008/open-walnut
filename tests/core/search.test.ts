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

  it('resolves exact and meaningful partial session IDs without QMD', () => {
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

describe('QMD memory search integration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/core/memory-search.js');
  });

  it('search() maps results from the QMD memory search lane', async () => {
    const mockMemoryNotesSearch = vi.fn().mockResolvedValue([
      {
        title: 'TypeScript patterns',
        snippet: 'Some content about TypeScript patterns',
        filepath: 'memory/notes.md',
        finalScore: 0.9,
        source: 'memory',
      },
      {
        title: 'More TypeScript',
        snippet: 'Another chunk about TypeScript',
        filepath: 'memory/other.md',
        finalScore: 0.7,
        source: 'memory',
      },
    ]);

    vi.doMock('../../src/core/memory-search.js', () => ({
      memoryNotesSearch: mockMemoryNotesSearch,
    }));

    const { search } = await import('../../src/core/search.js');
    const results = await search('TypeScript', { types: ['memory'] });

    expect(results.length).toBe(2);
    expect(results[0].type).toBe('memory');
    expect(results[0].matchField).toBe('memory');
    expect(results[0].path).toBe('memory/notes.md');
    // rerank MUST be false on this interactive lane. QMD's reranker is a local
    // llama.cpp cross-encoder: measured 11-20s on a cold query AND it pinned the
    // event loop for ~11s (one search froze every route in the app). Asserting the
    // options object here is the regression guard — a well-meaning "improve
    // relevance" change that drops it reintroduces an app-wide freeze.
    expect(mockMemoryNotesSearch).toHaveBeenCalledWith(
      'TypeScript',
      undefined,
      20,
      undefined,
      { rerank: false, overfetchMultiplier: 1 },
    );
  });

  it('surfaces a total QMD failure instead of returning an authoritative empty set', async () => {
    vi.doMock('../../src/core/memory-search.js', () => ({
      memoryNotesSearch: vi.fn().mockRejectedValue(new Error('Database not available')),
    }));

    const { search } = await import('../../src/core/search.js');
    await expect(search('TypeScript', { types: ['memory'] }))
      .rejects.toThrow('Database not available');
  });

  it('mixed CJK/Latin query: full-term-coverage hit outranks a higher-scored partial hit', async () => {
    // Task and memory stores rank independently; no-rerank scores are 1/rank,
    // so a memory doc matching ONLY "timeout" at its store's #1 (score 1.0 ×
    // weight 1.1) used to beat the task matching BOTH terms at its store's #2
    // (0.5). Coverage must win the cross-store merge for mixed queries.
    vi.doMock('../../src/core/task-manager.js', () => ({
      listTasks: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../src/core/session-tracker.js', () => ({
      listSessions: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../src/core/memory-search.js', () => ({
      memoryNotesSearch: vi.fn(async (_q: string, sources?: string[]) => {
        if (sources?.includes('task')) {
          return [{
            title: '请求 timeout 频发 — 查能否自动重试',
            snippet: '让 daemon 自动重试 timeout 的请求',
            filepath: 'qmd://task/task-t1',
            taskId: 't1',
            finalScore: 0.5,
            source: 'task',
          }];
        }
        return [{
          title: 'triage memory',
          snippet: 'unrelated doc that only mentions timeout once',
          filepath: 'memory/triage.md',
          finalScore: 1.1,
          source: 'memory_project',
        }];
      }),
    }));

    const { search } = await import('../../src/core/search.js');
    const results = await search('timeout 自动重试', { types: ['task', 'memory'] });

    expect(results[0].taskId).toBe('t1');
    expect(results[1].title).toBe('triage memory');
  });

  it('single-script query keeps pure score order (coverage tiebreak is a no-op)', async () => {
    vi.doMock('../../src/core/task-manager.js', () => ({
      listTasks: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../src/core/session-tracker.js', () => ({
      listSessions: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../src/core/memory-search.js', () => ({
      memoryNotesSearch: vi.fn(async (_q: string, sources?: string[]) => {
        if (sources?.includes('task')) {
          return [{
            title: 'timeout retry task', snippet: 'covers timeout and retry',
            filepath: 'qmd://task/task-t1', taskId: 't1', finalScore: 0.5, source: 'task',
          }];
        }
        return [{
          title: 'timeout-only doc', snippet: 'only timeout here',
          filepath: 'memory/m.md', finalScore: 1.1, source: 'memory_project',
        }];
      }),
    }));

    const { search } = await import('../../src/core/search.js');
    const results = await search('timeout retry', { types: ['task', 'memory'] });

    // Not a mixed-script query — higher raw score stays first even though
    // the task covers more terms.
    expect(results[0].title).toBe('timeout-only doc');
  });
});

describe('default search lanes (2026-08-15 star incident)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/core/memory-search.js');
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
    vi.doMock('../../src/core/task-manager.js', () => ({
      listTasks: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../src/core/session-tracker.js', () => ({
      listSessions: vi.fn().mockResolvedValue([]),
    }));
    const memoryNotesSearch = vi.fn(async (_q: string, sources?: string[]) => {
      if (sources?.includes('session')) {
        return [{
          title: 'star removal session',
          snippet: 'retire the star system — StarButton deleted',
          filepath: 'qmd://session/sess-8df36131',
          sessionId: '8df36131',
          finalScore: 0.9,
          source: 'session',
        }];
      }
      return [];
    });
    vi.doMock('../../src/core/memory-search.js', () => ({ memoryNotesSearch }));

    const { search } = await import('../../src/core/search.js');
    const results = await search('StarButton'); // deliberately NO types option

    const sessionLaneQueried = memoryNotesSearch.mock.calls.some(
      (c) => Array.isArray(c[1]) && c[1].includes('session'),
    );
    expect(sessionLaneQueried).toBe(true);
    expect(results.some((r) => r.type === 'session' && r.sessionId === '8df36131')).toBe(true);
  });
});
