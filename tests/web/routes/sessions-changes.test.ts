/**
 * Route tests for the session "Changed" view:
 *
 *   GET /api/sessions/:id/changes   → files the session changed, with
 *                                      reconstructed before/after for a diff.
 *
 * Detection is JSONL-only (per-session isolated). `after` is the file's current
 * content on disk, `before` is that content with the session's recorded ops
 * reverse-applied. We stage a real edited file + a session JSONL recording the
 * Edit, then assert the HTTP contract the SessionDiffView depends on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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

const SID = 'changes-route-sid';
// The edited file lives in a real temp repo (the engine reads its current bytes).
let REPO: string;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

async function writeSessionJsonl(cwd: string, lines: unknown[]) {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
  REPO = path.join(os.tmpdir(), `walnut-changes-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(path.join(REPO, '.git'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
});

describe('GET /api/sessions/:id/changes', () => {
  it('404 when the session does not exist', async () => {
    const res = await request(createApp()).get('/api/sessions/nope/changes');
    expect(res.status).toBe(404);
  });

  it('returns reconstructed before/after for an edited file', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    const file = path.join(REPO, 'app.ts');
    await fs.writeFile(file, 'const v = 2;\n');
    await writeSessionJsonl(REPO, [
      { type: 'user', cwd: REPO, message: { role: 'user', content: 'go' } },
      {
        type: 'assistant', cwd: REPO, timestamp: '2025-01-01T00:00:00Z',
        message: {
          id: 'a1', role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: file, old_string: 'const v = 1;', new_string: 'const v = 2;' } }],
        },
      },
    ]);

    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`);
    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(1);
    const change = res.body.groups[0].files[0];
    expect(change.after).toBe('const v = 2;\n');
    expect(change.before).toBe('const v = 1;\n');
    expect(change.status).toBe('modified');
    expect(res.body.groups[0].kind).toBe('cwd');
  });

  it('returns an empty result for a session that edited nothing', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    await writeSessionJsonl(REPO, [
      { type: 'user', cwd: REPO, message: { role: 'user', content: 'hi' } },
    ]);

    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`);
    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(0);
    expect(res.body.groups).toEqual([]);
  });

  it('?refresh=1 reflects fresh on-disk content (cache bypass)', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    const file = path.join(REPO, 'app.ts');
    await fs.writeFile(file, 'const v = 2;\n');
    await writeSessionJsonl(REPO, [
      {
        type: 'assistant', cwd: REPO, timestamp: '2025-01-01T00:00:00Z',
        message: {
          id: 'a1', role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: file, old_string: 'const v = 1;', new_string: 'const v = 2;' } }],
        },
      },
    ]);

    // Prime the cache.
    const first = await request(createApp()).get(`/api/sessions/${SID}/changes`);
    expect(first.body.groups[0].files[0].after).toBe('const v = 2;\n');

    // Mutate the file on disk WITHOUT touching the JSONL → mtime cache would be stale.
    await fs.writeFile(file, 'const v = 3;\n');
    const refreshed = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ refresh: '1' });
    expect(refreshed.body.groups[0].files[0].after).toBe('const v = 3;\n');
  });
});
