import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scoreMatch, extractSnippet, normalizedFuse, type SearchResult } from '../../src/core/search.js';

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

describe('FTS5 integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('search() integrates FTS results when memory-index is available', async () => {
    // Dynamically import search to test the FTS integration path
    // We mock memory-index to return controlled results
    const mockSearchIndex = vi.fn().mockReturnValue([
      { text: 'Some content about TypeScript patterns', path: 'memory/notes.md', score: 5.0 },
      { text: 'Another chunk about TypeScript', path: 'memory/other.md', score: 3.0 },
    ]);

    vi.doMock('../../src/core/memory-index.js', () => ({
      searchIndex: mockSearchIndex,
    }));

    // Also mock task-manager and memory to avoid file system access
    vi.doMock('../../src/core/task-manager.js', () => ({
      listTasks: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../src/core/memory.js', () => ({
      listMemories: vi.fn().mockReturnValue([]),
    }));

    const { search } = await import('../../src/core/search.js');
    // Use keyword mode to test FTS5 integration without Ollama dependency
    const results = await search('TypeScript', { types: ['memory'], mode: 'keyword' });

    expect(results.length).toBe(2);
    expect(results[0].type).toBe('memory');
    expect(results[0].matchField).toBe('content');
    expect(mockSearchIndex).toHaveBeenCalledWith('TypeScript', 20);

    vi.doUnmock('../../src/core/memory-index.js');
    vi.doUnmock('../../src/core/task-manager.js');
    vi.doUnmock('../../src/core/memory.js');
  });

  it('falls back to brute-force when FTS is unavailable', async () => {
    // Reset modules to ensure fresh imports
    vi.resetModules();

    // Mock searchIndex to throw, simulating FTS unavailability
    vi.doMock('../../src/core/memory-index.js', () => ({
      searchIndex: () => {
        throw new Error('Database not available');
      },
    }));

    vi.doMock('../../src/core/task-manager.js', () => ({
      listTasks: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../src/core/memory.js', () => ({
      listMemories: vi.fn().mockReturnValue([
        {
          title: 'Test Memory',
          content: 'Content about TypeScript patterns and best practices',
          path: 'memory/test.md',
          updatedAt: new Date().toISOString(),
        },
      ]),
    }));

    const { search } = await import('../../src/core/search.js');
    // Use keyword mode — this test verifies the brute-force fallback, not vector search
    const results = await search('TypeScript', { types: ['memory'], mode: 'keyword' });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('memory');

    vi.doUnmock('../../src/core/memory-index.js');
    vi.doUnmock('../../src/core/task-manager.js');
    vi.doUnmock('../../src/core/memory.js');
  });
});

// ── normalizedFuse unit tests ──

function makeResult(taskId: string, score: number, matchField = 'title'): SearchResult {
  return { type: 'task', title: taskId, snippet: '', taskId, score, matchField };
}

describe('normalizedFuse', () => {
  it('merges and ranks by weighted min-max scores', () => {
    const bm25 = [
      makeResult('A', 10),  // BM25 norm: 1.0
      makeResult('B', 5),   // BM25 norm: 0.0
    ];
    const vector = [
      makeResult('B', 0.9, 'semantic'),  // Vec norm: 1.0
      makeResult('A', 0.7, 'semantic'),  // Vec norm: 0.0
    ];

    const fused = normalizedFuse(bm25, vector);
    expect(fused).toHaveLength(2);
    // A: 0.4*1.0 + 0.6*0.0 = 0.4
    // B: 0.4*0.0 + 0.6*1.0 = 0.6
    // B should rank first (higher semantic score dominates with 60% weight)
    expect(fused[0].taskId).toBe('B');
    expect(fused[0].score).toBeCloseTo(0.6, 2);
    expect(fused[1].taskId).toBe('A');
    expect(fused[1].score).toBeCloseTo(0.4, 2);
  });

  it('handles disjoint result sets (no overlap)', () => {
    const bm25 = [makeResult('A', 5)];
    const vector = [makeResult('Z', 0.8, 'semantic')];

    const fused = normalizedFuse(bm25, vector);
    expect(fused).toHaveLength(2);
    // A: keyword only → 0.4 * 1.0 = 0.4 (single item normalizes to 1.0)
    // Z: semantic only → 0.6 * 1.0 = 0.6
    expect(fused[0].taskId).toBe('Z');
    expect(fused[0].score).toBeCloseTo(0.6, 2);
    expect(fused[1].taskId).toBe('A');
    expect(fused[1].score).toBeCloseTo(0.4, 2);
  });

  it('single result in each list normalizes to 1.0', () => {
    const bm25 = [makeResult('X', 3.14)];
    const vector = [makeResult('X', 0.42, 'semantic')];

    const fused = normalizedFuse(bm25, vector);
    expect(fused).toHaveLength(1);
    // Single-item lists both normalize to 1.0
    // 0.4 * 1.0 + 0.6 * 1.0 = 1.0
    expect(fused[0].score).toBeCloseTo(1.0, 2);
  });

  it('all-same BM25 scores normalize correctly (range=0 → fallback)', () => {
    const bm25 = [
      makeResult('A', 5),
      makeResult('B', 5),
      makeResult('C', 5),
    ];
    const vector: SearchResult[] = [];

    const fused = normalizedFuse(bm25, vector);
    expect(fused).toHaveLength(3);
    // All BM25 same → bm25Range = 0 → fallback || 1 → (5-5)/1 = 0
    // keyword only: 0.4 * 0 = 0
    for (const r of fused) {
      expect(r.score).toBeCloseTo(0, 5);
    }
  });

  it('preserves keywordScore and semanticScore on output', () => {
    const bm25 = [makeResult('A', 10), makeResult('B', 4)];
    const vector = [makeResult('A', 0.8, 'semantic')];

    const fused = normalizedFuse(bm25, vector);
    const a = fused.find(r => r.taskId === 'A')!;
    const b = fused.find(r => r.taskId === 'B')!;

    expect(a.keywordScore).toBeDefined();
    expect(a.semanticScore).toBeDefined();
    expect(a.keywordScore).toBe(1); // max BM25 → normalized 1.0
    expect(a.semanticScore).toBe(1); // single vec item → 1.0

    expect(b.keywordScore).toBeDefined();
    expect(b.semanticScore).toBeUndefined(); // not in vector results
  });

  it('respects alpha parameter', () => {
    const bm25 = [makeResult('A', 10)];
    const vector = [makeResult('B', 0.9, 'semantic')];

    // alpha=0.9 → heavy keyword weight
    const kwHeavy = normalizedFuse(bm25, vector, 0.9);
    expect(kwHeavy[0].taskId).toBe('A'); // keyword-only wins
    expect(kwHeavy[0].score).toBeCloseTo(0.9, 2);

    // alpha=0.1 → heavy semantic weight
    const semHeavy = normalizedFuse(bm25, vector, 0.1);
    expect(semHeavy[0].taskId).toBe('B'); // semantic-only wins
    expect(semHeavy[0].score).toBeCloseTo(0.9, 2);
  });

  it('min-max adapts to narrow cosine range (cross-language scenario)', () => {
    // Cross-language: all cosine scores are in a narrow band [0.31, 0.35]
    // With old hardcoded floor=0.5, ALL of these would normalize to 0
    // With result-set min-max, they spread across [0, 1]
    const bm25 = [makeResult('A', 5)]; // unrelated keyword match
    const vector = [
      makeResult('X', 0.35, 'semantic'), // best cross-lang match
      makeResult('Y', 0.33, 'semantic'),
      makeResult('Z', 0.31, 'semantic'), // worst cross-lang match
    ];

    const fused = normalizedFuse(bm25, vector);
    const x = fused.find(r => r.taskId === 'X')!;
    const z = fused.find(r => r.taskId === 'Z')!;

    // X should have highest semantic norm (1.0), Z should have lowest (0.0)
    expect(x.semanticScore).toBe(1);
    expect(z.semanticScore).toBe(0);
    // X's combined score should be meaningful, not near-zero
    expect(x.score).toBeGreaterThan(0.5);
  });

  it('title matches outrank semantic-only junk with default alpha', () => {
    // BM25 finds "Bug: fix login" with title match
    const bm25 = [
      makeResult('bug-1', 4.5),
      makeResult('bug-2', 4.5),
      makeResult('note-1', 1.5),
    ];
    // Vector returns random irrelevant high-similarity results
    const vector = [
      makeResult('junk-1', 0.47, 'semantic'),
      makeResult('junk-2', 0.45, 'semantic'),
      makeResult('bug-1', 0.52, 'semantic'),
    ];

    const fused = normalizedFuse(bm25, vector);
    // bug-1 should be #1 (has both keyword top + semantic top)
    expect(fused[0].taskId).toBe('bug-1');
    // bug-2 should be #2 (strong keyword, no semantic)
    expect(fused[1].taskId).toBe('bug-2');
    // note-1 has BM25 min (normalizes to 0) — with min-max, it falls below
    // semantic-only results that have non-zero normalized scores.
    // This is correct: min-max normalization reflects relative relevance within
    // each result set, not absolute importance of keyword vs semantic.
    const ids = fused.map(r => r.taskId);
    // 3 BM25 + 3 vector - 1 overlap (bug-1) = 5 unique results
    expect(ids).toHaveLength(5);
    // Top 2 are the keyword matches that also have high BM25 scores
    expect(ids[0]).toBe('bug-1');
    expect(ids[1]).toBe('bug-2');
  });
});
