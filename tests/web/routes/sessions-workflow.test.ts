/**
 * Route tests for dynamic-workflow reload persistence + subagent transcript drill-in.
 *
 *   GET /api/sessions/:id/workflow            → reconstruct panel from wf_*.json manifest
 *   GET /api/sessions/:id/subagent/:aid/history?workflow=1
 *                                             → full per-agent transcript (nested layout)
 *
 * Both read on-disk files Claude Code's Workflow tool writes under
 * ~/.claude/projects/<enc>/<sid>/{workflows,subagents/workflows}/. We stage real
 * fixtures and assert the HTTP contract the frontend depends on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js';

vi.mock('../../../src/constants.js', () => createMockConstants());
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord } from '../../../src/core/session-tracker.js';
import { encodeProjectPath } from '../../../src/core/session-file-reader.js';
import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js';

const CWD = '/Users/test/wf-routes';
const SID = 'wf-route-sid';
const RUN = 'wf_route-run-1';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

async function sessionDir(): Promise<string> {
  return path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), SID);
}

async function writeManifest() {
  const dir = path.join(await sessionDir(), 'workflows');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${RUN}.json`), JSON.stringify({
    runId: RUN,
    workflowName: 'read-six-synthesize',
    summary: 'Read files then synthesize',
    script: "export const meta = { name: 'read-six-synthesize' }",
    status: 'completed',
    totalTokens: 1234,
    startTime: 5000,
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Read' },
      { type: 'workflow_agent', index: 1, label: 'read:a', phaseIndex: 1, agentId: 'agA', model: 'global.anthropic.claude-opus-4-8[1m]', state: 'done', tokens: 500, durationMs: 1700, promptPreview: 'Read file a', resultPreview: 'summary a' },
    ],
  }));
}

async function writeAgentTranscript() {
  const dir = path.join(await sessionDir(), 'subagents', 'workflows', RUN);
  await fs.mkdir(dir, { recursive: true });
  // Standard session JSONL (same format parseSessionMessages handles).
  const lines = [
    JSON.stringify({ type: 'user', agentId: 'agA', message: { role: 'user', content: [{ type: 'text', text: 'Read file a' }] }, uuid: 'u1', timestamp: '2026-06-22T00:00:00Z' }),
    JSON.stringify({ type: 'assistant', agentId: 'agA', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'summary a' }], usage: { input_tokens: 10, output_tokens: 5 } }, uuid: 'a1', timestamp: '2026-06-22T00:00:01Z' }),
  ];
  await fs.writeFile(path.join(dir, 'agent-agA.jsonl'), lines.join('\n') + '\n');
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('GET /api/sessions/:id/workflow (reload persistence)', () => {
  it('204 when the session never ran a workflow', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', CWD);
    const res = await request(createApp()).get(`/api/sessions/${SID}/workflow`);
    expect(res.status).toBe(204);
  });

  it('reconstructs the panel payload from the on-disk manifest', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', CWD);
    await writeManifest();

    const res = await request(createApp()).get(`/api/sessions/${SID}/workflow`);
    expect(res.status).toBe(200);
    expect(res.body.workflowName).toBe('read-six-synthesize');
    expect(res.body.workflowDescription).toBe('Read files then synthesize');
    expect(res.body.scriptSource).toContain('read-six-synthesize');
    expect(res.body.inFlight).toBe(0); // finished run
    expect(res.body.phases).toHaveLength(1);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].agentId).toBe('agA');
    expect(res.body.agents[0].status).toBe('completed');
    expect(res.body.agents[0].resultPreview).toBe('summary a');
  });
});

describe('GET /api/sessions/:id/subagent/:aid/history?workflow=1 (transcript drill-in)', () => {
  it('returns the full per-agent transcript from the nested workflow layout', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', CWD);
    await writeAgentTranscript();

    const res = await request(createApp())
      .get(`/api/sessions/${SID}/subagent/agA/history`)
      .query({ workflow: '1' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
    expect(res.body.messages.length).toBe(2);
    expect(res.body.messages[0].role).toBe('user');
    expect(res.body.messages[1].role).toBe('assistant');
    expect(res.body.messages[1].text).toContain('summary a');
  });

  it('without ?workflow=1, the flat layout has no such agent → empty', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', CWD);
    await writeAgentTranscript(); // only in the nested workflow layout

    const res = await request(createApp())
      .get(`/api/sessions/${SID}/subagent/agA/history`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(0);
  });
});
