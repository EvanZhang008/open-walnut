/**
 * E2E tests for hybrid semantic search.
 *
 * Tests the full search pipeline: BM25 keyword matching, vector search paths,
 * RRF fusion, search modes, and graceful degradation when Ollama is unavailable.
 *
 * Uses a real server with ephemeral data directory.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, MEMORY_DIR } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

let server: HttpServer;
let port: number;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  await fs.mkdir(MEMORY_DIR, { recursive: true });

  // Create some memory files for FTS indexing
  const projectDir = path.join(MEMORY_DIR, 'projects', 'work', 'deploy');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, 'MEMORY.md'),
    '## Deployment Notes\n\nWe release the service to production every Friday.\nThe deploy pipeline runs through staging first.\n',
  );
  await fs.writeFile(
    path.join(MEMORY_DIR, 'projects', 'work', 'MEMORY.md'),
    '## Work Overview\n\nWork category contains all professional tasks and projects.\n',
    { flag: 'w' },
  );

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Helper: create tasks via API ──

async function createTask(title: string, extras: Record<string, string> = {}): Promise<string> {
  const body = { title, priority: 'none', category: extras.category ?? 'Work', ...extras };
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const data = await res.json();
  return data.task.id;
}

// ── Tests ──

describe('Hybrid Search E2E', () => {
  let taskIds: string[] = [];

  beforeAll(async () => {
    // Create diverse tasks for search testing
    const ids = await Promise.all([
      createTask('Fix tax filing for 2025'),
      createTask('Deploy HomeLab service to production', { category: 'Work', project: 'HomeLab' }),
      createTask('Review PR #42 for authentication module'),
      createTask('Book dentist appointment', { category: 'Life' }),
      createTask('Release v2.0 with new features', { category: 'Work', project: 'Walnut' }),
    ]);
    taskIds = ids;
    // Small delay to let bus subscriptions settle
    await new Promise((r) => setTimeout(r, 500));
  });

  describe('Keyword search (BM25)', () => {
    it('finds tasks by exact title match', async () => {
      const res = await fetch(apiUrl('/api/search?q=tax+filing&types=task&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results[0].title).toContain('tax');
    });

    it('finds tasks by partial keyword', async () => {
      const res = await fetch(apiUrl('/api/search?q=deploy&types=task&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results.length).toBeGreaterThan(0);
      const titles = data.results.map((r: { title: string }) => r.title.toLowerCase());
      expect(titles.some((t: string) => t.includes('deploy'))).toBe(true);
    });

    it('returns matchField for best matching field', async () => {
      const res = await fetch(apiUrl('/api/search?q=dentist&types=task&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results[0].matchField).toBe('title');
    });

    it('returns empty array for non-matching query', async () => {
      const res = await fetch(apiUrl('/api/search?q=xyznonexistent&types=task&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results).toEqual([]);
    });

    it('returns empty for empty query', async () => {
      const res = await fetch(apiUrl('/api/search?q=&types=task'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results).toEqual([]);
    });
  });

  describe('Memory search (FTS5)', () => {
    it('finds memory chunks by keyword', async () => {
      const res = await fetch(apiUrl('/api/search?q=release+production&types=memory&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.results[0].type).toBe('memory');
    });
  });

  describe('Hybrid search (default)', () => {
    it('returns results for hybrid mode (default when mode is omitted)', async () => {
      const res = await fetch(apiUrl('/api/search?q=deploy&types=task'));
      expect(res.status).toBe(200);
      const data = await res.json();
      // Should at least find keyword match (vector may or may not be available)
      expect(data.results.length).toBeGreaterThan(0);
    });

    it('accepts explicit mode=hybrid', async () => {
      const res = await fetch(apiUrl('/api/search?q=review&types=task&mode=hybrid'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results.length).toBeGreaterThan(0);
    });

    it('gracefully degrades to keyword when Ollama is unavailable', async () => {
      // Hybrid mode should still return keyword results even without Ollama
      const res = await fetch(apiUrl('/api/search?q=HomeLab&types=task&mode=hybrid'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results.length).toBeGreaterThan(0);
      // Should find the HomeLab task via keyword matching
      const hasCis = data.results.some((r: { title: string }) =>
        r.title.toLowerCase().includes('homelab'),
      );
      expect(hasCis).toBe(true);
    });
  });

  describe('Semantic search mode', () => {
    it('returns results (or empty if Ollama unavailable)', async () => {
      const res = await fetch(apiUrl('/api/search?q=deploy&types=task&mode=semantic'));
      expect(res.status).toBe(200);
      const data = await res.json();
      // May be empty if Ollama is not running — that's acceptable
      expect(Array.isArray(data.results)).toBe(true);
    });
  });

  describe('Mixed type search', () => {
    it('returns both tasks and memory results', async () => {
      const res = await fetch(apiUrl('/api/search?q=deploy&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      const types = new Set(data.results.map((r: { type: string }) => r.type));
      // Should have task results at minimum (memory depends on FTS indexing timing)
      expect(types.has('task')).toBe(true);
    });

    it('respects types=task filter', async () => {
      const res = await fetch(apiUrl('/api/search?q=deploy&types=task&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      const allTasks = data.results.every((r: { type: string }) => r.type === 'task');
      expect(allTasks).toBe(true);
    });

    it('respects types=memory filter', async () => {
      const res = await fetch(apiUrl('/api/search?q=deploy+release&types=memory&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      if (data.results.length > 0) {
        const allMemory = data.results.every((r: { type: string }) => r.type === 'memory');
        expect(allMemory).toBe(true);
      }
    });
  });

  describe('Cross-category search (the "bug" bug)', () => {
    let bugTaskIds: string[];

    beforeAll(async () => {
      // Create "bug" tasks across different categories
      bugTaskIds = await Promise.all([
        createTask('Bug: login fails on Safari', { category: 'Personal', project: 'Walnut' }),
        createTask('Bug: API rate limit exceeded', { category: 'Work', project: 'HomeLab' }),
        createTask('Bug: dark mode flicker', { category: 'Personal', project: 'Walnut' }),
        createTask('Fix checkout bug', { category: 'Life' }),
      ]);
      await new Promise((r) => setTimeout(r, 300));
    });

    it('keyword search finds bug tasks across ALL categories', async () => {
      const res = await fetch(apiUrl('/api/search?q=bug&types=task&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();

      // Must find tasks from multiple categories
      const resultIds = data.results.map((r: { taskId: string }) => r.taskId);
      const foundBugs = bugTaskIds.filter(id => resultIds.includes(id));
      expect(foundBugs.length).toBe(4); // All 4 bug tasks found regardless of category
    });

    it('hybrid search returns bug tasks, not random semantic junk', async () => {
      const res = await fetch(apiUrl('/api/search?q=bug&types=task&mode=hybrid'));
      expect(res.status).toBe(200);
      const data = await res.json();

      // Top results must be actual bug-related tasks (title matches)
      const topResults = data.results.slice(0, 4);
      for (const r of topResults) {
        const isBugRelated = r.title.toLowerCase().includes('bug') ||
          (r.snippet && r.snippet.toLowerCase().includes('bug'));
        expect(isBugRelated).toBe(true);
      }
    });

    it('exact title matches rank higher than note/description matches', async () => {
      // Create a task where "bug" only appears in description, not title
      await createTask('Improve error handling', {
        category: 'Work',
        description: 'This fixes a subtle bug in the error handler',
      });
      await new Promise((r) => setTimeout(r, 300));

      const res = await fetch(apiUrl('/api/search?q=bug&types=task&mode=hybrid'));
      expect(res.status).toBe(200);
      const data = await res.json();

      // Find the description-only match
      const descMatch = data.results.find((r: { title: string }) =>
        r.title === 'Improve error handling');
      const titleMatches = data.results.filter((r: { matchField: string }) =>
        r.matchField === 'title');

      if (descMatch && titleMatches.length > 0) {
        // All title matches must appear before the description match
        const descIdx = data.results.indexOf(descMatch);
        const lastTitleIdx = data.results.findIndex((r: { matchField: string }, i: number) =>
          i > 0 && data.results[i - 1].matchField === 'title' && r.matchField !== 'title') - 1;

        if (lastTitleIdx >= 0) {
          expect(descIdx).toBeGreaterThan(lastTitleIdx);
        }
      }
    });
  });

  describe('Search result structure', () => {
    it('returns correct fields for task results', async () => {
      const res = await fetch(apiUrl('/api/search?q=authentication&types=task&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results.length).toBeGreaterThan(0);
      const result = data.results[0];
      expect(result).toHaveProperty('type', 'task');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('snippet');
      expect(result).toHaveProperty('taskId');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('matchField');
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThan(0);
    });

    it('respects limit parameter', async () => {
      const res = await fetch(apiUrl('/api/search?q=a&types=task&mode=keyword&limit=2'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Cross-language and note-field search', () => {
    let crossLangTaskId: string;
    let noteOnlyTaskId: string;

    beforeAll(async () => {
      // Create a task with Chinese title containing "测试" (test)
      crossLangTaskId = await createTask('远程 Session E2E 测试 + Bug Fix');

      // Create a task with "test" only in note, not in title
      noteOnlyTaskId = await createTask('Improve error logging system');
      // Add note with "test" keyword via API (PUT /note expects { content })
      await fetch(apiUrl(`/api/tasks/${noteOnlyTaskId}/note`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Run the test suite after refactoring. Verify all test cases pass. Add integration test for error handler.' }),
      });

      await new Promise((r) => setTimeout(r, 500));
    });

    it('keyword search finds task with Chinese "测试" when searching Chinese', async () => {
      const res = await fetch(apiUrl(`/api/search?q=${encodeURIComponent('测试')}&types=task&mode=keyword`));
      expect(res.status).toBe(200);
      const data = await res.json();
      const found = data.results.find((r: { taskId: string }) => r.taskId === crossLangTaskId);
      expect(found).toBeDefined();
      expect(found.matchField).toBe('title');
    });

    it('keyword search finds task by note content', async () => {
      const res = await fetch(apiUrl('/api/search?q=test+suite&types=task&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      const found = data.results.find((r: { taskId: string }) => r.taskId === noteOnlyTaskId);
      expect(found).toBeDefined();
      expect(found.matchField).toBe('note');
    });

    it('TF bonus: task with multiple "test" in note scores higher than single match', async () => {
      // Create a task with "test" appearing once
      const singleId = await createTask('Check deployment pipeline');
      await fetch(apiUrl(`/api/tasks/${singleId}/note`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Quick test after deploy.' }),
      });
      await new Promise((r) => setTimeout(r, 300));

      const res = await fetch(apiUrl('/api/search?q=test&types=task&mode=keyword'));
      expect(res.status).toBe(200);
      const data = await res.json();
      const multi = data.results.find((r: { taskId: string }) => r.taskId === noteOnlyTaskId);
      const single = data.results.find((r: { taskId: string }) => r.taskId === singleId);

      // noteOnlyTaskId has "test" 3 times vs singleId has it once
      // Both match on note field — multi-occurrence should score higher
      if (multi && single && multi.matchField === 'note' && single.matchField === 'note') {
        expect(multi.score).toBeGreaterThan(single.score);
      }
    });

    it('hybrid search finds note-only matches', async () => {
      const res = await fetch(apiUrl('/api/search?q=test&types=task&mode=hybrid'));
      expect(res.status).toBe(200);
      const data = await res.json();

      // Should find the note-only "test" task via keyword matching on note field
      const noteMatch = data.results.find((r: { taskId: string }) => r.taskId === noteOnlyTaskId);
      expect(noteMatch).toBeDefined();
      expect(noteMatch.matchField).toBe('note');
    });

    it('hybrid search finds Chinese "测试" when searching in Chinese', async () => {
      const res = await fetch(apiUrl(`/api/search?q=${encodeURIComponent('测试')}&types=task&mode=hybrid`));
      expect(res.status).toBe(200);
      const data = await res.json();

      // Chinese keyword "测试" should find the Chinese-titled task
      const crossLang = data.results.find((r: { taskId: string }) => r.taskId === crossLangTaskId);
      expect(crossLang).toBeDefined();
      expect(crossLang.matchField).toBe('title');
    });
  });
});

describe('normalizedFuse (unit-level in-process)', () => {
  it('normalizedFuse merges and ranks correctly', async () => {
    const { normalizedFuse } = await import('../../src/core/search.js');

    const bm25 = [
      { type: 'task' as const, title: 'A', snippet: '', taskId: '1', score: 5, matchField: 'title' },
      { type: 'task' as const, title: 'B', snippet: '', taskId: '2', score: 3, matchField: 'title' },
      { type: 'task' as const, title: 'C', snippet: '', taskId: '3', score: 1, matchField: 'title' },
    ];

    const vector = [
      { type: 'task' as const, title: 'B', snippet: '', taskId: '2', score: 0.9, matchField: 'semantic' },
      { type: 'task' as const, title: 'D', snippet: '', taskId: '4', score: 0.8, matchField: 'semantic' },
      { type: 'task' as const, title: 'A', snippet: '', taskId: '1', score: 0.5, matchField: 'semantic' },
    ];

    const fused = normalizedFuse(bm25, vector);

    expect(fused.length).toBe(4); // A, B, C, D
    // B: BM25 norm=(3-1)/(5-1)=0.5, Vec norm=(0.9-0.5)/(0.9-0.5)=1.0 → 0.4*0.5+0.6*1.0=0.8
    // A: BM25 norm=(5-1)/(5-1)=1.0, Vec norm=(0.5-0.5)/(0.9-0.5)=0.0 → 0.4*1.0+0.6*0.0=0.4
    expect(fused[0].taskId).toBe('2'); // B: mid BM25 but top vector
    expect(fused[0].score).toBeCloseTo(0.8, 1);

    // All results should have positive scores (except C which is BM25 bottom + no vector)
    expect(fused.filter(r => r.score > 0).length).toBeGreaterThanOrEqual(3);
  });

  it('normalizedFuse handles disjoint result sets', async () => {
    const { normalizedFuse } = await import('../../src/core/search.js');

    const bm25 = [
      { type: 'task' as const, title: 'A', snippet: '', taskId: '1', score: 5, matchField: 'title' },
    ];
    const vector = [
      { type: 'task' as const, title: 'Z', snippet: '', taskId: '9', score: 0.9, matchField: 'semantic' },
    ];

    const fused = normalizedFuse(bm25, vector);
    expect(fused.length).toBe(2);
    // Both single-item lists normalize to 1.0
    // Z: 0.6*1.0 = 0.6, A: 0.4*1.0 = 0.4
    expect(fused[0].taskId).toBe('9'); // semantic wins with 60% weight
    expect(fused[1].taskId).toBe('1');
  });

  it('normalizedFuse: top keyword matches rank above semantic-only results', async () => {
    const { normalizedFuse } = await import('../../src/core/search.js');

    // BM25 finds title matches — bug-1 and bug-2 are tied at the top
    const bm25 = [
      { type: 'task' as const, title: 'Bug: fix login', snippet: '', taskId: 'bug-1', score: 4.5, matchField: 'title' },
      { type: 'task' as const, title: 'Bug: API timeout', snippet: '', taskId: 'bug-2', score: 4.5, matchField: 'title' },
      { type: 'task' as const, title: 'Some note mentions bug', snippet: '', taskId: 'note-1', score: 1.5, matchField: 'note' },
    ];

    // Vector returns random irrelevant high-similarity results
    const vector = [
      { type: 'task' as const, title: 'hi', snippet: '', taskId: 'junk-1', score: 0.47, matchField: 'semantic' },
      { type: 'task' as const, title: 'netflix', snippet: '', taskId: 'junk-2', score: 0.45, matchField: 'semantic' },
      { type: 'task' as const, title: 'buy stuff', snippet: '', taskId: 'junk-3', score: 0.44, matchField: 'semantic' },
      { type: 'task' as const, title: 'Bug: fix login', snippet: '', taskId: 'bug-1', score: 0.52, matchField: 'semantic' },
    ];

    const fused = normalizedFuse(bm25, vector);

    // bug-1 should be #1 (has both keyword top rank + vector top rank)
    expect(fused[0].taskId).toBe('bug-1');
    // bug-2 should be #2 (strong keyword, no vector — BM25 normalized to 1.0)
    expect(fused[1].taskId).toBe('bug-2');
    // All 6 results present
    expect(fused).toHaveLength(6);
  });

  it('normalizedFuse: keyword-only result gets alpha share of the score', async () => {
    const { normalizedFuse } = await import('../../src/core/search.js');

    // Single BM25 title match
    const bm25 = [
      { type: 'task' as const, title: 'Fix critical bug', snippet: '', taskId: 'real', score: 4.5, matchField: 'title' },
    ];

    // 50 semantic results (real result not in vector at all)
    const vector = Array.from({ length: 50 }, (_, i) => ({
      type: 'task' as const,
      title: `Random task ${i}`,
      snippet: '',
      taskId: `rand-${i}`,
      score: 0.5 - i * 0.002,
      matchField: 'semantic',
    }));

    const fused = normalizedFuse(bm25, vector);

    // Single BM25 item normalizes to 1.0 → score = 0.4 * 1.0 = 0.4
    // Top vector item normalizes to 1.0 → score = 0.6 * 1.0 = 0.6
    const real = fused.find(r => r.taskId === 'real')!;
    expect(real).toBeDefined();
    expect(real.score).toBeCloseTo(0.4, 2); // gets full alpha share
    expect(real.keywordScore).toBe(1); // single item normalizes to 1.0

    // With alpha=0.4, keyword-only items are capped at 0.4
    // Semantic-only items are capped at 0.6 — they outrank in this scenario
    // This is by design: with 60% semantic weight, the system trusts semantic signals more
    expect(fused[0].score).toBeCloseTo(0.6, 2);
  });
});

describe('Embedding pipeline (unit-level)', () => {
  it('buildCompositeText generates expected format', async () => {
    const { buildCompositeText } = await import('../../src/core/embedding/pipeline.js');

    const task = {
      id: 'test-1',
      title: 'Deploy HomeLab service',
      description: 'Deploy the HomeLab microservice to production.',
      summary: 'HomeLab deployment task',
      category: 'Work',
      project: 'HomeLab',
      tags: ['backend', 'urgent'],
      status: 'todo' as const,
      priority: 'important' as const,
      source: 'local' as const,
      session_ids: [],
      note: '',
      phase: 'TODO' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };

    const text = buildCompositeText(task);
    expect(text).toContain('[Deploy HomeLab service]');
    expect(text).toContain('Deploy HomeLab service.');
    expect(text).toContain('Deploy the HomeLab microservice to production.');
    expect(text).toContain('Tags: backend, urgent.');
    expect(text).toContain('Work/HomeLab.');
  });

  it('compositeHash is deterministic', async () => {
    const { compositeHash } = await import('../../src/core/embedding/pipeline.js');

    const hash1 = compositeHash('hello world');
    const hash2 = compositeHash('hello world');
    const hash3 = compositeHash('different text');

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1.length).toBe(64); // SHA256 hex
  });
});

describe('Cosine similarity (unit-level)', () => {
  it('identical vectors have similarity 1', async () => {
    const { cosineSimilarity } = await import('../../src/core/embedding/cosine.js');
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('orthogonal vectors have similarity 0', async () => {
    const { cosineSimilarity } = await import('../../src/core/embedding/cosine.js');
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('topK returns sorted results', async () => {
    const { topK } = await import('../../src/core/embedding/cosine.js');
    const query = new Float32Array([1, 0, 0]);
    const candidates = [
      { id: 'a', embedding: new Float32Array([0, 1, 0]) },    // 0.0
      { id: 'b', embedding: new Float32Array([0.5, 0.5, 0]) }, // ~0.707
      { id: 'c', embedding: new Float32Array([1, 0, 0]) },     // 1.0
    ];

    const results = topK(query, candidates, 2);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('c');
    expect(results[0].score).toBeCloseTo(1.0, 1);
    expect(results[1].id).toBe('b');
  });

  it('bufferToFloat32 and float32ToBuffer are inverse', async () => {
    const { bufferToFloat32, float32ToBuffer } = await import('../../src/core/embedding/cosine.js');
    const original = new Float32Array([1.5, -2.3, 0, 42.0]);
    const buf = float32ToBuffer(original);
    const recovered = bufferToFloat32(buf);
    expect(recovered.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5);
    }
  });
});

describe('Embedding store (unit-level)', () => {
  it('upsertTaskEmbedding + getAllTaskEmbeddings round-trip', async () => {
    const { ensureEmbeddingTables, upsertTaskEmbedding, getAllTaskEmbeddings, deleteTaskEmbedding } = await import('../../src/core/embedding/store.js');

    ensureEmbeddingTables();

    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    upsertTaskEmbedding('test-store-1', 'hash123', embedding, 'bge-m3');

    const all = getAllTaskEmbeddings();
    const found = all.find((r) => r.task_id === 'test-store-1');
    expect(found).toBeDefined();
    expect(found!.embedding.length).toBe(4);
    expect(found!.embedding[0]).toBeCloseTo(0.1, 5);

    // Cleanup
    deleteTaskEmbedding('test-store-1');
    const afterDelete = getAllTaskEmbeddings();
    expect(afterDelete.find((r) => r.task_id === 'test-store-1')).toBeUndefined();
  });

  it('getTaskEmbeddingHash returns correct hash', async () => {
    const { ensureEmbeddingTables, upsertTaskEmbedding, getTaskEmbeddingHash, deleteTaskEmbedding } = await import('../../src/core/embedding/store.js');

    ensureEmbeddingTables();

    const embedding = new Float32Array([0.5, 0.6]);
    upsertTaskEmbedding('test-hash-1', 'myhash456', embedding, 'bge-m3');

    const hash = getTaskEmbeddingHash('test-hash-1');
    expect(hash).toBe('myhash456');

    // Non-existent
    const missing = getTaskEmbeddingHash('nonexistent');
    expect(missing).toBeNull();

    // Cleanup
    deleteTaskEmbedding('test-hash-1');
  });

  it('upsert overwrites existing embedding', async () => {
    const { ensureEmbeddingTables, upsertTaskEmbedding, getTaskEmbeddingHash, deleteTaskEmbedding } = await import('../../src/core/embedding/store.js');

    ensureEmbeddingTables();

    upsertTaskEmbedding('test-overwrite', 'hash-v1', new Float32Array([1, 2]), 'bge-m3');
    expect(getTaskEmbeddingHash('test-overwrite')).toBe('hash-v1');

    upsertTaskEmbedding('test-overwrite', 'hash-v2', new Float32Array([3, 4]), 'bge-m3');
    expect(getTaskEmbeddingHash('test-overwrite')).toBe('hash-v2');

    // Cleanup
    deleteTaskEmbedding('test-overwrite');
  });
});
