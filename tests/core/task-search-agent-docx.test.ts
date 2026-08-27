/**
 * THE ACCEPTANCE CASE (public-safe synthetic) — reproduces the 2026-08-23
 * production failure shape, PRE-RENAME:
 *   - owning task: PLACEHOLDER title ("Session: <folder>"), EMPTY note/summary
 *   - all intent exists ONLY in the linked session's indexed text
 *   - types=['task'] search is therefore structurally blind to it
 * The agent pipeline must still return the OWNING TASK as the primary result,
 * with transcript evidence, deduped, via the session lane's owner join.
 *
 * Never assert on a "fixed" title — the placeholder shape IS the test.
 * docx-preview / xlsx / pptx-preview are public npm package names (safe).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

// Deterministic BM25 lanes: no QMD, no embeddings, no v2 index. Restored in
// afterEach so the flag never leaks into other files in this worker.
const prevDisableSearch = process.env.WALNUT_DISABLE_SEARCH;
process.env.WALNUT_DISABLE_SEARCH = '1';

const { aiDisabledRef, listSessionsMock } = vi.hoisted(() => ({
  aiDisabledRef: { value: false },
  listSessionsMock: vi.fn(),
}));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-search-agent-docx'));
vi.mock('../../src/core/cheap-model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/cheap-model.js')>()),
  backgroundAiDisabled: () => aiDisabledRef.value,
}));
vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: listSessionsMock,
}));

import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../src/constants.js';
import { _resetForTesting, addTask } from '../../src/core/task-manager.js';
import { search } from '../../src/core/search.js';
import {
  runTaskSearchAgent,
  _resetAgentSearchStateForTesting,
  type AgentSearchEngine,
} from '../../src/core/task-search-agent.js';

const SESSION_ID = 'aaaa1111-2222-4333-8444-555566667777';

beforeEach(async () => {
  aiDisabledRef.value = false;
  _resetForTesting();
  _resetAgentSearchStateForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  _resetForTesting();
  _resetAgentSearchStateForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterAll(() => {
  if (prevDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH;
  else process.env.WALNUT_DISABLE_SEARCH = prevDisableSearch;
});

describe('agent task search — placeholder-title task found via session evidence', () => {
  it('returns the owning task as the primary clickable result', async () => {
    // Placeholder shape: title says nothing, note/summary deliberately empty.
    const { task } = await addTask({ title: 'Session: notes-app', project: 'notes-app' });
    listSessionsMock.mockResolvedValue([{
      claudeSessionId: SESSION_ID,
      taskId: task.id, // ← the owner mapping the whole feature rides on
      title: 'Session: notes-app',
      description: 'npm install docx-preview xlsx pptx-preview — extend the file '
        + 'preview feature to Office documents (docx, xlsx, pptx)',
    }]);

    // Sanity gate: the task lane is BLIND to this shape (zero query terms in
    // the task doc). If this ever finds it, the fixture no longer reproduces
    // the production failure and the test must be rethought.
    const taskLaneOnly = await search('docx office preview', { types: ['task'] });
    expect(taskLaneOnly.filter((r) => r.taskId === task.id)).toEqual([]);

    // Scripted engine standing in for the claude -p child: iterates query
    // variants (incl. a CJK translation), reads the session lane, and returns
    // the OWNING task id it saw there — fenced, to exercise tolerant parsing.
    const laneCalls: Array<{ query: string; types: string[] }> = [];
    const engine: AgentSearchEngine = async () => {
      // round 1 — the user's words, task lane: comes back empty
      laneCalls.push({ query: 'which task adds docx support', types: ['task'] });
      const r1 = await search('which task adds docx support', { types: ['task'] });
      expect(r1.filter((r) => r.taskId === task.id)).toEqual([]);
      // round 2 — transcript vocabulary + a translated variant, both lanes
      for (const q of ['docx xlsx office preview', 'docx 预览 文件']) {
        laneCalls.push({ query: q, types: ['task', 'session'] });
      }
      const r2 = await search('docx xlsx office preview', { types: ['task', 'session'] });
      const sessionHit = r2.find((r) => r.type === 'session' && r.sessionId === SESSION_ID);
      expect(sessionHit).toBeDefined();
      expect(sessionHit!.taskId).toBe(task.id); // owner join present in the lane
      return {
        response: '```json\n' + JSON.stringify({
          summary: 'The Office-preview work lives in one session-created task.',
          results: [
            { task_id: sessionHit!.taskId, evidence: sessionHit!.snippet.slice(0, 160), confidence: 'high' },
            // The model also lists the same task under its 8-char prefix (a
            // "task hit" duplicate) — must collapse to ONE result.
            { task_id: sessionHit!.taskId!.slice(0, 8), evidence: 'duplicate', confidence: 'medium' },
          ],
        }) + '\n```',
      };
    };

    const res = await runTaskSearchAgent(
      'which walnut task is expanding the file feature to add docx', { engine });

    // Multi-round with a translated variant actually happened.
    expect(laneCalls.length).toBeGreaterThanOrEqual(2);
    expect(laneCalls.some((c) => c.types.includes('session'))).toBe(true);
    expect(laneCalls.some((c) => /[㐀-鿿]/.test(c.query))).toBe(true);

    // The owning TASK is the one and only primary result.
    expect(res.results).toHaveLength(1);
    expect(res.results[0].taskId).toBe(task.id);
    expect(res.results[0].evidence.toLowerCase()).toContain('docx');
    expect(res.results[0].confidence).toBe('high');
    // Title comes from the record and is still the placeholder — by design.
    expect(typeof res.results[0].title).toBe('string');
    // No session rows leak into the response shape.
    for (const row of res.results) {
      expect('sessionId' in row).toBe(false);
    }
  });
});
