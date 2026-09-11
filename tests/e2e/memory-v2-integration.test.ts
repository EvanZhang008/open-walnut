/**
 * Category 7: Integration Tests (Cross-Subsystem)
 *
 * Tests full end-to-end flows across the search index, memory tools, working
 * memory, and the HTTP API layer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
import {
  seedDailyLog,
  seedTopicFile,
  seedGlobalMemory,
  daysAgoStr,
} from '../helpers/memory-v2-seeders.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, workingMemoryFile } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import {
  resetSearchV2IndexForTests,
  sweepSearchV2Files,
} from '../../src/core/search/wiring.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

/** Search the way every surface does now: the server's own /api/search route. */
async function searchRows(
  query: string,
  types?: string,
): Promise<Array<{ type: string; title: string; snippet?: string; path?: string; filepath?: string }>> {
  const qs = new URLSearchParams({ q: query, ...(types ? { types } : {}) });
  const res = await fetch(apiUrl(`/api/search?${qs.toString()}`));
  expect(res.status).toBe(200);
  const data = await res.json() as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []) as Array<{ type: string; title: string; snippet?: string; path?: string; filepath?: string }>;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });

  // Seed diverse files for integration tests
  seedTopicFile(
    WALNUT_HOME,
    'kubernetes',
    '---\ntitle: Kubernetes\nupdated: 2026-04-10\ntags: [k8s, infra]\n---\n\n## Overview\n\nKubernetes pod autoscaling with HPA and VPA.\n\n## Key Facts\n- HPA scales based on CPU/memory metrics\n- VPA adjusts resource requests\n- Pod Disruption Budgets protect availability\n',
  );
  seedDailyLog(
    WALNUT_HOME,
    daysAgoStr(0),
    'Worked on Kubernetes cluster scaling and memory v2 integration tests.',
  );
  seedGlobalMemory(
    WALNUT_HOME,
    'Global memory unique marker xylophone_quantum_entanglement_test_marker for integration tests.',
  );
  // Working memory is per-conversation and lives under conversations/ — outside
  // every indexed root. Seeded here so 7.3 can prove it stays out of search.
  const wmPath = workingMemoryFile('general', 'conv-memory-v2-integration');
  await fs.mkdir(path.dirname(wmPath), { recursive: true });
  await fs.writeFile(
    wmPath,
    '# Active Focus\nRunning memory v2 integration tests with unique_wm_marker_12345.\n',
    'utf-8',
  );

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Index the seeded files now rather than waiting out the server's delayed
  // startup backfill — the sweep upserts inline, so the queries below are
  // deterministic.
  await sweepSearchV2Files();
}, 120000);

afterAll(async () => {
  await stopServer();
  resetSearchV2IndexForTests();
  // Teardown only: the just-stopped server can still flush a WAL/log file
  // into the temp home while we unlink it (ENOTEMPTY under load). Retry,
  // then let the OS reap the temp dir rather than failing a green suite.
  await fs
    .rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    .catch(() => {});
}, 30000);

describe('Category 7: Integration Tests', () => {
  // ── 7.1 Index Search Through HTTP API ──

  it('7.1: index search works through HTTP API', async () => {
    const res = await fetch(apiUrl('/api/search?q=Kubernetes&types=memory'));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);

    // Data was seeded and indexed — results must exist
    expect(data.results.length).toBeGreaterThan(0);

    const memoryResults = data.results.filter(
      (r: { type: string }) => r.type === 'memory',
    );
    expect(memoryResults.length).toBeGreaterThan(0);
  });

  // ── 7.2 End-to-End: Seed -> Index -> Search -> Get ──

  it('7.2: full pipeline from seed to search to get', async () => {
    const searchResults = await searchRows('pod autoscaling', 'memory');
    expect(searchResults.length).toBeGreaterThan(0);

    const topResult = searchResults.find((r) =>
      `${r.path ?? r.filepath ?? ''}`.includes('kubernetes')
      || `${r.title}${r.snippet ?? ''}`.includes('Kubernetes'),
    );
    expect(topResult).toBeDefined();
  });

  // ── 7.3 Working Memory NOT Visible in Search ──

  it('7.3: working memory is NOT indexed', async () => {
    // The volatile scratchpad lives under conversations/, which is not one of
    // the indexed roots (memory/, notes/, skills/) — so it can never leak into
    // recall no matter what the user typed into it.
    const results = await searchRows('unique_wm_marker_12345');

    const wmResult = results.find((r) =>
      `${r.title}${r.snippet ?? ''}${r.path ?? r.filepath ?? ''}`.includes('unique_wm_marker_12345'),
    );
    expect(wmResult).toBeUndefined();
  });

  // ── 7.4 Global MEMORY.md in Search ──

  it('7.4: global MEMORY.md is reachable through search', async () => {
    const results = await searchRows('xylophone_quantum_entanglement_test_marker', 'memory');
    expect(results.length).toBeGreaterThan(0);

    const globalResult = results.find((r) =>
      `${r.path ?? r.filepath ?? ''}`.endsWith('MEMORY.md'),
    );
    expect(globalResult).toBeDefined();
  });
});
