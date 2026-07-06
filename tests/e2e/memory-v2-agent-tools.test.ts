/**
 * Category 5: Agent Memory Tools E2E
 *
 * Tests the memory_notes_search agent tool with a real server
 * and real QMD stores. No QMD mocking — files are seeded and indexed for real.
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
import { waitForSearchResults } from '../helpers/qmd-wait.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { memoryNotesSearchTool } from '../../src/agent/tools/memory-notes-search-tool.js';
import { memoryNotesSearch } from '../../src/core/memory-search.js';

let server: HttpServer;
let port: number;

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });

  // Seed files
  seedTopicFile(
    WALNUT_HOME,
    'api-design',
    '## API Design\n\nREST API conventions, versioning, and authentication patterns for the backend.',
  );
  seedTopicFile(
    WALNUT_HOME,
    'deployment',
    '## Deployment\n\nDocker + Kubernetes deployment pipeline with staging and production.',
  );
  seedDailyLog(
    WALNUT_HOME,
    daysAgoStr(0),
    'Worked on PostgreSQL connection optimization and API rate limiting.',
  );
  seedDailyLog(
    WALNUT_HOME,
    '2026-01-15',
    'Memory v2 agent tools E2E test day.',
  );
  seedProjectMemory(
    WALNUT_HOME,
    'work',
    'backend',
    'Backend project uses Express + PostgreSQL + Redis.',
  );
  seedGlobalMemory(
    WALNUT_HOME,
    'Global memory: dark mode, concise responses, TypeScript preferred.',
  );
  seedNotesFile(
    WALNUT_HOME,
    'Areas',
    'work',
    'Work area: engineering tasks, code reviews, deployments.',
  );
  seedNotesFile(
    WALNUT_HOME,
    'Projects',
    'frontend',
    'Frontend project: React, TypeScript, Vite bundler.',
  );
  seedNotesFile(
    WALNUT_HOME,
    'Resources',
    'typescript-guide',
    'TypeScript best practices and patterns.',
  );

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Wait for QMD indexing — memory store AND the notes vault. The notes
  // index bootstraps LAZILY on first notes-v2 API hit (see notes-v2.ts
  // ensureIndexBootstrap), so touch the route once before waiting.
  await waitForSearchResults(
    () => memoryNotesSearch('API design'),
    { maxWaitMs: 60000, pollIntervalMs: 2000 },
  );
  await fetch(`http://localhost:${port}/api/notes-v2/list`);
  await waitForSearchResults(
    () => memoryNotesSearch('engineering work', ['note_vault']),
    { maxWaitMs: 60000, pollIntervalMs: 2000 },
  );
}, 150000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
}, 30000);

// ── 5.1 memory_notes_search Tool - Basic Search ──

describe('memory_notes_search Tool', () => {
  it('5.1: basic search returns JSON with correct fields', async () => {
    const result = await memoryNotesSearchTool.execute({ queries: ['PostgreSQL connection'] });

    expect(result).not.toBe('No results found.');
    const parsed = JSON.parse(result as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    // Verify result shape
    for (const r of parsed) {
      expect(r).toHaveProperty('source');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('snippet');
      expect(r).toHaveProperty('filepath');
      expect(r).toHaveProperty('score');
      expect(typeof r.score).toBe('number');
    }

    // At least one result should contain the search term in snippet or title
    const hasRelevantResult = parsed.some(
      (r: { snippet: string; title: string }) =>
        r.snippet.toLowerCase().includes('postgresql') ||
        r.snippet.toLowerCase().includes('connection') ||
        r.title.toLowerCase().includes('postgresql') ||
        r.title.toLowerCase().includes('connection'),
    );
    expect(hasRelevantResult).toBe(true);

    // Score should be rounded to 3 decimal places
    for (const r of parsed) {
      const str = r.score.toString();
      const decimals = str.includes('.') ? str.split('.')[1].length : 0;
      expect(decimals).toBeLessThanOrEqual(3);
    }
  });

  // ── 5.2 Source Filtering ──

  it('5.2: source filtering limits results to specified sources', async () => {
    const result = await memoryNotesSearchTool.execute({
      queries: ['design'],
      sources: ['memory_topic'],
    });

    expect(result).not.toBe('No results found.');

    const parsed = JSON.parse(result as string);
    for (const r of parsed) {
      expect(r.source).toBe('memory_topic');
    }
  });

  // ── 5.3 Notes Sources ──

  it('5.3: notes source filtering works', async () => {
    // Notes are a single flattened `note_vault` collection (PARA folders merged).
    const result = await memoryNotesSearchTool.execute({
      queries: ['engineering work'],
      sources: ['note_vault'],
    });

    expect(result).not.toBe('No results found.');

    const parsed = JSON.parse(result as string);
    for (const r of parsed) {
      expect(r.source).toBe('note_vault');
    }
  });

  // ── 5.4 Limit ──

  it('5.4: respects limit parameter', async () => {
    const result = await memoryNotesSearchTool.execute({
      queries: ['design deployment'],
      limit: 3,
    });

    expect(result).not.toBe('No results found.');

    const parsed = JSON.parse(result as string);
    expect(parsed.length).toBeLessThanOrEqual(3);
  });

  // ── 5.5 No Results / Non-matching Query ──

  it('5.5: returns valid response for nonexistent term', async () => {
    const result = await memoryNotesSearchTool.execute({
      queries: ['xylophone_nonexistent_term_12345_zzz'],
    });

    // QMD BM25 may return fuzzy partial matches — verify either "No results found."
    // or valid JSON array is returned (not an error)
    if (result === 'No results found.') {
      expect(result).toBe('No results found.');
    } else {
      const parsed = JSON.parse(result as string);
      expect(Array.isArray(parsed)).toBe(true);
      // Results should have valid shape
      for (const r of parsed) {
        expect(r).toHaveProperty('source');
        expect(r).toHaveProperty('score');
      }
    }
  });
});

