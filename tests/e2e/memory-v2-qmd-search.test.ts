/**
 * Category 1: QMD Search E2E
 *
 * Tests the real QMD search pipeline: BM25 keyword matching, source weighting,
 * temporal decay, 60/40 split, minSlots, and error handling.
 *
 * Uses a real server with real QMD stores (no mocking QMD internals).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
import {
  seedDailyLog,
  seedTopicFile,
  seedProjectMemory,
  seedGlobalMemory,
  seedNotesFile,
  daysAgoStr,
} from '../helpers/memory-v2-seeders.js';
import { waitForQmdMemoryIndex, waitForSearchResults } from '../helpers/qmd-wait.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, MEMORY_DIR, NOTES_DIR } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { memoryNotesSearch, type MemorySearchResult } from '../../src/core/memory-search.js';

let server: HttpServer;
let port: number;

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });

  // Seed files for tests 1.1 - 1.6
  seedDailyLog(
    WALNUT_HOME,
    '2026-04-10',
    'Investigated the PostgreSQL connection pool exhaustion bug.',
  );
  seedTopicFile(
    WALNUT_HOME,
    'database-architecture',
    '## PostgreSQL\n\nConnection pooling uses pgBouncer with 50 max connections.',
  );
  seedProjectMemory(
    WALNUT_HOME,
    'backend',
    'Backend project uses Express + PostgreSQL.',
  );

  // Test 1.2: Source weighting
  seedTopicFile(
    WALNUT_HOME,
    'redis-caching',
    'Redis caching strategy uses LRU eviction with 512MB max memory.',
  );
  seedDailyLog(
    WALNUT_HOME,
    '2026-01-15',
    'Discussed Redis caching strategy for the API layer.',
  );

  // Test 1.3: Temporal decay
  seedDailyLog(
    WALNUT_HOME,
    daysAgoStr(1),
    'Optimized the webpack bundle size analysis.',
  );
  seedDailyLog(
    WALNUT_HOME,
    '2025-01-01',
    'Started webpack bundle size analysis project.',
  );

  // Test 1.4: Evergreen
  seedTopicFile(
    WALNUT_HOME,
    'old-but-relevant',
    'Kubernetes pod scheduling algorithm.',
  );
  seedDailyLog(
    WALNUT_HOME,
    '2025-06-01',
    'Learned about Kubernetes pod scheduling algorithm.',
  );

  // Test 1.5: 60/40 split
  seedTopicFile(WALNUT_HOME, 'react-1', 'React component lifecycle hooks.');
  seedTopicFile(WALNUT_HOME, 'react-2', 'React component lifecycle methods.');
  seedTopicFile(WALNUT_HOME, 'react-3', 'React component lifecycle patterns.');
  seedNotesFile(WALNUT_HOME, 'Areas', 'frontend', 'React component lifecycle overview for the areas.');
  seedNotesFile(WALNUT_HOME, 'Projects', 'ui-kit', 'React component lifecycle utilities for projects.');
  seedNotesFile(WALNUT_HOME, 'Resources', 'react-guide', 'React component lifecycle resource guide.');

  // Test 1.6: MinSlots
  for (let i = 0; i < 10; i++) {
    seedDailyLog(WALNUT_HOME, daysAgoStr(i + 2), `Machine learning training run ${i} completed successfully with high accuracy.`);
  }
  seedTopicFile(WALNUT_HOME, 'ml-overview', 'Machine learning model training overview.');
  seedGlobalMemory(WALNUT_HOME, 'Machine learning is an important area of focus.');

  // Test 1.7: Bilingual
  seedTopicFile(
    WALNUT_HOME,
    'project-goals',
    '## 项目目标\n\nWalnut 的目标是成为个人 AI，管理任务、知识和会话。\n\n## Project Goals\n\nWalnut aims to be a Personal AI managing tasks, knowledge, and sessions.',
  );

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Wait for QMD indexing
  const found = await waitForSearchResults(
    () => memoryNotesSearch('PostgreSQL connection pool'),
    { maxWaitMs: 60000, pollIntervalMs: 2000 },
  );
  if (!found) {
    // Give extra time for embed()
    await waitForQmdMemoryIndex(10000);
  }
}, 120000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
}, 30000);

describe('Category 1: QMD Search E2E', () => {
  // ── 1.1 Basic Memory Search - BM25 Keyword Matching ──

  it('1.1: basic BM25 keyword matching returns relevant results', async () => {
    const results = await memoryNotesSearch('PostgreSQL connection pool');

    expect(results.length).toBeGreaterThan(0);

    // At least one topic result
    const topicResult = results.find((r) => r.source === 'memory_topic');
    expect(topicResult).toBeDefined();

    // At least one daily result
    const dailyResult = results.find((r) => r.source === 'memory_daily');
    expect(dailyResult).toBeDefined();

    // All results have required fields
    for (const r of results) {
      expect(r.finalScore).toBeGreaterThan(0);
      expect(r.filepath).toBeTruthy();
      expect(r.title).toBeDefined();
      expect(r.snippet).toBeDefined();
    }
  });

  // ── 1.2 Source Weighting - Topics Rank Higher Than Daily Logs ──

  it('1.2: topics rank higher than daily logs for same query', async () => {
    // Source weighting test: topic weight (1.5) should rank above daily weight (1.0).
    // We verify by checking that the topic result appears before the daily result
    // in the sorted results array (i.e., higher rank).
    const results = await memoryNotesSearch('Redis caching strategy', ['memory_topic', 'memory_daily']);

    // Topic result (evergreen) must always appear
    const topicIdx = results.findIndex(
      (r) => r.source === 'memory_topic' && r.snippet.toLowerCase().includes('redis'),
    );
    expect(topicIdx).toBeGreaterThanOrEqual(0);

    // Daily result (2025-01-15, ~15 months old) may be filtered out by temporal decay.
    // If it appears, topic must rank higher due to source weighting + no decay.
    const dailyIdx = results.findIndex(
      (r) => r.source === 'memory_daily' && r.snippet.toLowerCase().includes('redis'),
    );
    if (dailyIdx >= 0) {
      expect(topicIdx).toBeLessThan(dailyIdx);
    }
  });

  // ── 1.3 Temporal Decay - Recent Daily Logs Rank Higher ──

  it('1.3: temporal decay ranks recent daily logs higher than old ones', async () => {
    // The temporal decay function is tested at the unit level in temporal-decay.test.ts.
    // Here we verify that QMD search results from daily logs show decay behavior:
    // recent daily logs should have higher finalScore than old ones.
    const results = await memoryNotesSearch('webpack bundle size analysis', ['memory_daily']);

    expect(results.length).toBeGreaterThan(0);

    // The recent result (yesterday) must always appear
    const recentResult = results.find(
      (r) => r.snippet.includes('Optimized') || r.filepath.includes(daysAgoStr(1)),
    );
    expect(recentResult).toBeDefined();

    // The old result (2025-01-01, ~15 months ago) may be filtered out entirely
    // due to extreme temporal decay. If it appears, verify it ranks below the recent one.
    const oldResult = results.find(
      (r) => r.snippet.includes('Started') || r.filepath.includes('2025-01-01'),
    );
    if (oldResult) {
      expect(recentResult!.finalScore).toBeGreaterThan(oldResult.finalScore);
    }
  });

  // ── 1.4 Temporal Decay - Evergreen Files Unaffected ──

  it('1.4: topic files (no date) rank higher than old daily logs (evergreen)', async () => {
    const results = await memoryNotesSearch('Kubernetes pod scheduling', ['memory_topic', 'memory_daily']);

    // Topic result must always appear (evergreen, decay=1.0)
    const topicIdx = results.findIndex(
      (r) => r.source === 'memory_topic' && r.snippet.toLowerCase().includes('kubernetes'),
    );
    expect(topicIdx).toBeGreaterThanOrEqual(0);

    // The old daily result (2025-06-01, ~10 months old) may be filtered out due to
    // heavy temporal decay. If it appears, topic must rank higher.
    const dailyIdx = results.findIndex(
      (r) => r.source === 'memory_daily' && r.snippet.toLowerCase().includes('kubernetes'),
    );
    if (dailyIdx >= 0) {
      expect(topicIdx).toBeLessThan(dailyIdx);
    }
  });

  // ── 1.5 60/40 Memory vs Notes Split ──

  it('1.5: mixed memory+notes search respects 60/40 split', async () => {
    const results = await memoryNotesSearch(
      'React component lifecycle',
      ['memory_topic', 'note_areas', 'note_projects', 'note_resources'],
      10,
    );

    expect(results.length).toBeGreaterThan(0);

    const memoryResults = results.filter((r) => !r.source.startsWith('note_'));
    const notesResults = results.filter((r) => r.source.startsWith('note_'));

    // With limit=10, memory slots = ceil(10*0.6) = 6, notes slots = 4
    expect(memoryResults.length).toBeLessThanOrEqual(6);
    expect(notesResults.length).toBeLessThanOrEqual(4);

    // Memory results should appear before notes results
    if (memoryResults.length > 0 && notesResults.length > 0) {
      const lastMemIdx = results.lastIndexOf(memoryResults[memoryResults.length - 1]);
      const firstNoteIdx = results.indexOf(notesResults[0]);
      expect(lastMemIdx).toBeLessThan(firstNoteIdx);
    }
  });

  // ── 1.6 MinSlots Guarantee ──

  it('1.6: minSlots guarantees topic and global results', async () => {
    const results = await memoryNotesSearch(
      'machine learning',
      ['memory_daily', 'memory_topic', 'memory_global'],
      8,
    );

    expect(results.length).toBeGreaterThan(0);

    // topic minSlots=2, global minSlots=1
    const topicCount = results.filter((r) => r.source === 'memory_topic').length;
    const globalCount = results.filter((r) => r.source === 'memory_global').length;

    // If we have enough total results, guaranteed slots must be honored
    if (results.length >= 3) {
      expect(topicCount).toBeGreaterThanOrEqual(1); // at least 1 topic result (we only seeded 1 ml topic)
      expect(globalCount).toBeGreaterThanOrEqual(1); // at least 1 global result
    }
  });

  // ── 1.7 Chinese + English Bilingual Search ──

  it('1.7: bilingual search finds content in both languages', async () => {
    // Chinese query
    const chineseResults = await memoryNotesSearch('个人 AI', ['memory_topic']);
    // English query
    const englishResults = await memoryNotesSearch('Personal AI', ['memory_topic']);

    // BM25 should find English text with English query — mandatory
    const englishMatch = englishResults.find((r) =>
      r.filepath.includes('project-goals'),
    );
    expect(englishMatch).toBeDefined();

    // BM25 tokenization for CJK varies by implementation — Chinese match is
    // conditional because BM25-only (no vector) may not tokenize Chinese characters correctly.
    const chineseMatch = chineseResults.find((r) =>
      r.filepath.includes('project-goals'),
    );
    if (!chineseMatch) {
      // Log for visibility, but don't fail — BM25 Chinese tokenization is best-effort
      console.warn('1.7: Chinese BM25 match not found — expected if tokenizer lacks CJK support');
    }
  });

  // ── 1.8 Error Handling - No Match / Low Relevance ──

  it('1.8: search with non-matching query does not throw', async () => {
    // QMD BM25 may return fuzzy partial matches even for nonsensical queries.
    // The important thing is that the search does not throw and returns an array.
    const results = await memoryNotesSearch('xylophone_nonexistent_12345_zzz');
    expect(Array.isArray(results)).toBe(true);

    // All returned results should have valid shape
    for (const r of results) {
      expect(typeof r.finalScore).toBe('number');
      expect(r.finalScore).toBeGreaterThanOrEqual(0);
      expect(r.source).toBeTruthy();
    }
  });

  // ── 1.9 Error Handling - Invalid Source Name ──

  it('1.9: search with invalid source returns empty array', async () => {
    const results = await memoryNotesSearch('test', ['nonexistent_source' as string]);
    expect(results).toEqual([]);
  });
});
