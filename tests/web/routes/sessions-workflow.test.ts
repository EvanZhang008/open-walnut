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
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js';
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

// Claude Code truncates an encoded cwd over 200 chars and appends a hash it computes
// with Bun.hash, which Walnut does not replicate: the session's project folder can
// only be found, never computed. Every read below must still land on it.
describe('hashed-cwd session (encoded cwd over 200 chars)', () => {
  const LONG_CWD = '/Users/test/' + Array.from({ length: 12 }, (_, i) => `deeply-nested-folder-${i}`).join('/');
  const LONG_SID = 'wf-long-cwd-sid';
  const projectDir = () => path.join(CLAUDE_HOME, 'projects', encodeProjectPath(LONG_CWD).slice(0, 200) + '-x1y2z3');

  function agentLines(agentId: string, text: string): string {
    return [
      JSON.stringify({ type: 'user', agentId, message: { role: 'user', content: [{ type: 'text', text: 'Check the fleet' }] }, uuid: `${agentId}-u1`, timestamp: '2026-10-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', agentId, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } }, uuid: `${agentId}-a1`, timestamp: '2026-10-01T00:00:01Z' }),
    ].join('\n') + '\n';
  }

  async function stageSession() {
    const dir = projectDir();
    await fs.mkdir(path.join(dir, LONG_SID, 'subagents', 'workflows', RUN), { recursive: true });
    await fs.mkdir(path.join(dir, LONG_SID, 'workflows'), { recursive: true });
    await fs.writeFile(path.join(dir, `${LONG_SID}.jsonl`), JSON.stringify({
      type: 'user', cwd: LONG_CWD, uuid: 'm1', timestamp: '2026-10-01T00:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }) + '\n');
    await fs.writeFile(path.join(dir, LONG_SID, 'subagents', 'agent-a6f8e0001.jsonl'), agentLines('a6f8e0001', 'flat agent done'));
    await fs.writeFile(path.join(dir, LONG_SID, 'subagents', 'workflows', RUN, 'agent-a6f8e0002.jsonl'), agentLines('a6f8e0002', 'workflow agent done'));
    await fs.writeFile(path.join(dir, LONG_SID, 'workflows', `${RUN}.json`), JSON.stringify({
      runId: RUN, workflowName: 'long-cwd-run', startTime: 1,
      workflowProgress: [{ type: 'workflow_agent', index: 1, label: 'check', agentId: 'a6f8e0002', state: 'done' }],
    }));
    await createSessionRecord(LONG_SID, 'task-long', 'proj', LONG_CWD);
  }

  it('is the case under test: the cwd cannot be encoded exactly', () => {
    expect(encodeProjectPath(LONG_CWD).length).toBeGreaterThan(200);
  });

  it('reads a background agent transcript before the session history was ever loaded', async () => {
    await stageSession();
    const res = await request(createApp()).get(`/api/sessions/${LONG_SID}/subagent/a6f8e0001/history`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[1].text).toContain('flat agent done');
  });

  it('reads a workflow agent transcript and the workflow manifest', async () => {
    await stageSession();
    const app = createApp();
    const agent = await request(app).get(`/api/sessions/${LONG_SID}/subagent/a6f8e0002/history`).query({ workflow: '1' });
    expect(agent.body.messages).toHaveLength(2);
    expect(agent.body.messages[1].text).toContain('workflow agent done');
    const wf = await request(app).get(`/api/sessions/${LONG_SID}/workflow`);
    expect(wf.status).toBe(200);
    expect(wf.body.workflowName).toBe('long-cwd-run');
  });

  it('answers an empty transcript, not an error, for an agent with no file', async () => {
    await stageSession();
    const res = await request(createApp()).get(`/api/sessions/${LONG_SID}/subagent/a6f8e0009/history`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(0);
  });
});

// Where an earlier read found the session JSONL is tried first, and the cwd-encoded
// folder after it: each covers a case the other gets wrong.
describe('subagent transcript: remembered folder vs the cwd-encoded one', () => {
  function agentJsonl(agentId: string): string {
    return [
      JSON.stringify({ type: 'user', agentId, message: { role: 'user', content: [{ type: 'text', text: 'go' }] }, uuid: `${agentId}-u`, timestamp: '2026-10-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', agentId, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'agent answer' }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: `${agentId}-a`, timestamp: '2026-10-01T00:00:01Z' }),
    ].join('\n') + '\n';
  }

  async function stageIn(folder: string, sid: string, cwd: string, agentId: string) {
    const dir = path.join(CLAUDE_HOME, 'projects', folder);
    await fs.mkdir(path.join(dir, sid, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(dir, `${sid}.jsonl`), JSON.stringify({
      type: 'user', cwd, uuid: 'm1', timestamp: '2026-10-01T00:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }) + '\n');
    await fs.writeFile(path.join(dir, sid, 'subagents', `agent-${agentId}.jsonl`), agentJsonl(agentId));
  }

  it('finds the folder Claude Code used for a symlinked cwd once the history read located it', async () => {
    // The record says /Users/test/link; Claude Code wrote under the resolved path.
    const sid = 'symlinked-cwd-sid';
    await stageIn(encodeProjectPath('/Volumes/real/target'), sid, '/Volumes/real/target', 'b0b0b0b1');
    await createSessionRecord(sid, 'task-sym', 'proj', '/Users/test/link');
    const app = createApp();
    expect((await request(app).get(`/api/sessions/${sid}/history`)).status).toBe(200);
    const res = await request(app).get(`/api/sessions/${sid}/subagent/b0b0b0b1/history`);
    expect(res.body.messages).toHaveLength(2);
  });

  it('reads the new folder after a cwd move left the remembered one stale', async () => {
    const sid = 'moved-cwd-sid';
    const oldCwd = '/Users/test/before-move';
    const newCwd = '/Users/test/after-move';
    await stageIn(encodeProjectPath(oldCwd), sid, oldCwd, 'c0c0c0c1');
    await createSessionRecord(sid, 'task-move', 'proj', oldCwd);
    const app = createApp();
    expect((await request(app).get(`/api/sessions/${sid}/history`)).status).toBe(200);
    // What a cwd migration does: the files move, the record follows.
    await fs.rename(path.join(CLAUDE_HOME, 'projects', encodeProjectPath(oldCwd)), path.join(CLAUDE_HOME, 'projects', encodeProjectPath(newCwd)));
    await updateSessionRecord(sid, { cwd: newCwd });
    const res = await request(app).get(`/api/sessions/${sid}/subagent/c0c0c0c1/history`);
    expect(res.body.messages).toHaveLength(2);
  });
});
