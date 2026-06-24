/**
 * HIGH-FIDELITY proof that the three Compare modes are SEMANTICALLY DISTINCT —
 * the exact confusion the user reported ("why are Session changes and vs-last-commit
 * so different? shouldn't they be the same?").
 *
 * The answer: each mode anchors `before` to a DIFFERENT point, so when a session
 * both COMMITS something AND leaves uncommitted work AND has unpushed commits, the
 * three modes legitimately show different file sets / content. This test builds ONE
 * real git repo with a real bare remote that reproduces all three conditions at
 * once, then asserts each mode side-by-side.
 *
 *   timeline in ONE repo:
 *     ── origin/main (pushed) ───────────────────────────────  base.ts = "pushed"
 *           │                                                  app.ts  = "v0"
 *           ▼  (session commits this locally, NOT pushed)
 *        local commit                                          app.ts  = "v1"  ← session edit #1, committed
 *           │
 *           ▼  (session leaves this uncommitted in the worktree)
 *        working tree                                          app.ts  = "v2"  ← session edit #2, uncommitted
 *                                                              other.ts= "dirty" ← a CONCURRENT process, NOT this session
 *
 *   What each mode must return for app.ts (the file the session edited twice):
 *     • What this session changed (base=session)  → before "v0"  after "v2"  (spans the commit it made)
 *     • Uncommitted changes        (base=uncommitted=HEAD) → before "v1"  after "v2"  (only the un-committed delta)
 *     • Not yet pushed             (base=remote=origin)     → before "v0"  after "v2"  (everything since the push)
 *
 *   And the scope contract: other.ts (a concurrent process dirtied it, the session
 *   never touched it) is INVISIBLE in scope=session for every git mode, but VISIBLE
 *   under scope=all.
 *
 * Real git, real commits, real push to a real bare remote, real session JSONL.
 * Would these pass with the feature reverted? No — they assert the precise
 * before/after each baseline yields, which only holds if base-rev resolution +
 * session scoping are correct.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createSessionRecord } from '../../../src/core/session-tracker.js';
import { encodeProjectPath } from '../../../src/core/session-file-reader.js';
import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js';

const execFileAsync = promisify(execFile);
const SID = 'compare-diverge-sid';
let REPO: string;
let REMOTE: string;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

async function git(cwd: string, ...args: string[]) {
  await execFileAsync('git', args, { cwd, encoding: 'utf-8' });
}

async function initRepo(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
}

/** Write a session JSONL recording a list of Edit ops (in order). */
async function writeSessionJsonl(cwd: string, edits: Array<{ file: string; oldStr: string; newStr: string }>) {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwd));
  await fs.mkdir(dir, { recursive: true });
  const lines: unknown[] = [{ type: 'user', cwd, message: { role: 'user', content: 'go' } }];
  edits.forEach((e, i) => {
    lines.push({
      type: 'assistant', cwd, timestamp: '2025-01-01T00:00:00Z',
      message: {
        id: `a${i}`, role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'Edit', input: { file_path: e.file, old_string: e.oldStr, new_string: e.newStr } }],
      },
    });
  });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

const fileOf = (body: { groups: Array<{ files: Array<{ relPath: string; before: string; after: string; status: string }> }> }, rel: string) =>
  body.groups.flatMap((g) => g.files).find((f) => f.relPath === rel);
const allPaths = (body: { groups: Array<{ files: Array<{ relPath: string }> }> }) =>
  body.groups.flatMap((g) => g.files.map((f) => f.relPath)).sort();

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  REPO = path.join(os.tmpdir(), `walnut-cmp-${tag}`);
  REMOTE = path.join(os.tmpdir(), `walnut-cmp-remote-${tag}.git`);
  await initRepo(REPO);
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
  await fs.rm(REMOTE, { recursive: true, force: true }).catch(() => {});
});

/**
 * Build the full scenario ONCE: pushed baseline → session's local commit →
 * session's uncommitted edit → a concurrent process dirties an unrelated file.
 * Returns nothing; leaves REPO + JSONL in the diverged state.
 */
async function buildDivergedScenario() {
  await createSessionRecord(SID, 'task-1', 'proj', REPO);

  // 1. Pushed baseline: app.ts=v0, base.ts=pushed, other.ts=clean. Push to remote.
  await git(path.dirname(REMOTE), 'init', '-q', '--bare', path.basename(REMOTE));
  await fs.writeFile(path.join(REPO, 'app.ts'), 'v0\n');
  await fs.writeFile(path.join(REPO, 'base.ts'), 'pushed\n');
  await fs.writeFile(path.join(REPO, 'other.ts'), 'clean\n');
  await git(REPO, 'add', '-A');
  await git(REPO, 'commit', '-q', '-m', 'pushed baseline');
  await git(REPO, 'remote', 'add', 'origin', REMOTE);
  await git(REPO, 'push', '-q', '-u', 'origin', 'main');

  // 2. The session edits app.ts v0→v1 and COMMITS it locally (does NOT push).
  await fs.writeFile(path.join(REPO, 'app.ts'), 'v1\n');
  await git(REPO, 'add', 'app.ts');
  await git(REPO, 'commit', '-q', '-m', 'session local commit (unpushed)');

  // 3. The session edits app.ts again v1→v2, LEAVES it uncommitted.
  await fs.writeFile(path.join(REPO, 'app.ts'), 'v2\n');

  // 4. A CONCURRENT process (NOT this session) dirties other.ts.
  await fs.writeFile(path.join(REPO, 'other.ts'), 'dirty\n');

  // The session's JSONL records BOTH of its app.ts edits, in order. It never
  // touched other.ts (so scope=session must exclude it).
  await writeSessionJsonl(REPO, [
    { file: path.join(REPO, 'app.ts'), oldStr: 'v0', newStr: 'v1' },
    { file: path.join(REPO, 'app.ts'), oldStr: 'v1', newStr: 'v2' },
  ]);
}

describe('Compare modes diverge in ONE repo (the user-reported confusion, proven)', () => {
  it('base=session → spans the in-session commit: before v0, after v2', async () => {
    await buildDivergedScenario();
    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'session' });
    expect(res.status).toBe(200);
    const app = fileOf(res.body, 'app.ts');
    expect(app).toBeTruthy();
    // Reconstructed from the session's OWN edits (v0→v1→v2), spanning the commit
    // it made → the full delta the session is responsible for.
    expect(app!.before).toBe('v0\n');
    expect(app!.after).toBe('v2\n');
  });

  it('base=uncommitted → only the UN-committed delta: before v1 (HEAD), after v2', async () => {
    await buildDivergedScenario();
    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted' });
    expect(res.status).toBe(200);
    const app = fileOf(res.body, 'app.ts');
    expect(app).toBeTruthy();
    // HEAD already contains v1 (the session committed it) → git diff HEAD only sees
    // v1→v2. THIS is why it differs from base=session: the committed part is invisible.
    expect(app!.before).toBe('v1\n');
    expect(app!.after).toBe('v2\n');
  });

  it('base=remote → everything since the push: before v0 (origin), after v2', async () => {
    await buildDivergedScenario();
    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'remote' });
    expect(res.status).toBe(200);
    const app = fileOf(res.body, 'app.ts');
    expect(app).toBeTruthy();
    // origin/main still has v0 (nothing pushed since) → spans the local commit AND
    // the uncommitted edit. Same endpoints as base=session HERE, but for a different
    // reason (git baseline vs reconstruction) — and they'd diverge the moment you push.
    expect(app!.before).toBe('v0\n');
    expect(app!.after).toBe('v2\n');
  });

  it('the three modes are genuinely distinct: uncommitted.before (v1) ≠ session/remote.before (v0)', async () => {
    await buildDivergedScenario();
    const app = createApp();
    const [s, u, r] = await Promise.all([
      request(app).get(`/api/sessions/${SID}/changes`).query({ base: 'session' }),
      request(app).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted' }),
      request(app).get(`/api/sessions/${SID}/changes`).query({ base: 'remote' }),
    ]);
    const sb = fileOf(s.body, 'app.ts')!.before;
    const ub = fileOf(u.body, 'app.ts')!.before;
    const rb = fileOf(r.body, 'app.ts')!.before;
    // The heart of the user's confusion, asserted: "uncommitted" sees a narrower
    // span because the session's own commit is already in HEAD.
    expect(ub).toBe('v1\n');
    expect(sb).toBe('v0\n');
    expect(rb).toBe('v0\n');
    expect(ub).not.toBe(sb);
  });

  it('scope contract: a concurrent process\'s file (other.ts) is hidden in scope=session, shown in scope=all', async () => {
    await buildDivergedScenario();
    const app = createApp();
    // scope=session (default): only app.ts (the file THIS session edited).
    const sess = await request(app).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted' });
    expect(allPaths(sess.body)).toEqual(['app.ts']);
    expect(fileOf(sess.body, 'other.ts')).toBeFalsy();

    // scope=all: every change in the touched repo, incl. the concurrent other.ts.
    const all = await request(app).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted', scope: 'all' });
    expect(allPaths(all.body)).toEqual(['app.ts', 'other.ts']);
    expect(fileOf(all.body, 'other.ts')!.after).toBe('dirty\n');
  });

  it('base.ts (committed+pushed, untouched since) appears in NO mode — nothing diffs it', async () => {
    await buildDivergedScenario();
    const app = createApp();
    for (const base of ['session', 'uncommitted', 'remote'] as const) {
      const res = await request(app).get(`/api/sessions/${SID}/changes`).query({ base, scope: 'all' });
      expect(fileOf(res.body, 'base.ts'), `base.ts must not show for base=${base}`).toBeFalsy();
    }
  });
});
