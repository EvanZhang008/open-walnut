/**
 * Route tests for the git comparison-base modes of the "Changed" view:
 *
 *   GET /api/sessions/:id/changes?base=uncommitted  → `git diff HEAD`
 *   GET /api/sessions/:id/changes?base=previous     → `git diff HEAD~1`
 *   GET /api/sessions/:id/changes?base=remote        → `git diff @{upstream}`
 *
 * THE CONTRACT (the bug these guard): the git modes are scoped to the repos THIS
 * session actually EDITED — never the cwd repo wholesale. The base only changes
 * the baseline `before`/`after` is read from; it never widens the file set to
 * "everything in whatever repo the cwd sits in". So:
 *   - A session that edited nothing → EMPTY in every base (even if the cwd repo
 *     has piles of uncommitted changes). This is the regression: anchoring on cwd
 *     used to surface unrelated repo changes the session never made.
 *   - scope=session (default) → only the files the session edited, with git's
 *     before/after.
 *   - scope=all → every change in the TOUCHED repos (a concurrent process may
 *     have dirtied a sibling file), but still never an untouched repo.
 *
 * We build a real local git repo with real commits + a real "remote", write a
 * real session JSONL recording the edits, then assert the HTTP contract the
 * SessionDiffView renders from ({groups,files,before,after}).
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
const SID = 'git-diff-route-sid';
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

/** A real local repo with deterministic identity + no GPG/hooks interference. */
async function initRepo(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
}

/**
 * Stage a session JSONL recording Edit ops, so the git modes know which repo(s)
 * + files this session touched. Each edit is an Edit tool_use on an absolute path.
 */
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

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  REPO = path.join(os.tmpdir(), `walnut-gitdiff-${tag}`);
  REMOTE = path.join(os.tmpdir(), `walnut-gitdiff-remote-${tag}.git`);
  await initRepo(REPO);
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
  await fs.rm(REMOTE, { recursive: true, force: true }).catch(() => {});
});

describe('GET /api/sessions/:id/changes?base= (git modes, scoped to touched repos)', () => {
  it('base=uncommitted → the session\'s edited file, before=HEAD / after=working tree', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    await fs.writeFile(path.join(REPO, 'app.ts'), 'const v = 1;\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'baseline');
    // The session edits app.ts (recorded in JSONL) → working tree now differs from HEAD.
    await fs.writeFile(path.join(REPO, 'app.ts'), 'const v = 2;\n');
    await writeSessionJsonl(REPO, [{ file: path.join(REPO, 'app.ts'), oldStr: 'const v = 1;', newStr: 'const v = 2;' }]);

    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted' });
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    const f = res.body.groups[0].files.find((x: { relPath: string }) => x.relPath === 'app.ts');
    expect(f).toBeTruthy();
    expect(f.before).toBe('const v = 1;\n'); // git HEAD content
    expect(f.after).toBe('const v = 2;\n');  // working tree
    expect(f.status).toBe('modified');
  });

  it('REGRESSION: a session that edited NOTHING → empty, even when the cwd repo has uncommitted changes', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    await fs.writeFile(path.join(REPO, 'app.ts'), 'const v = 1;\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'baseline');
    // The repo is dirty (someone else's uncommitted change + a random untracked file)…
    await fs.writeFile(path.join(REPO, 'app.ts'), 'const v = 2;\n');
    await fs.writeFile(path.join(REPO, 'random-untracked.txt'), 'scratch\n');
    // …but THIS session edited nothing (no JSONL). The old cwd-wholesale behavior
    // returned both files here; the corrected behavior returns empty.
    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted' });
    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(0);
    expect(res.body.groups).toEqual([]);
  });

  it('base=previous → vs the commit BEFORE the latest (HEAD~1), incl. the latest commit', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    // commit 1 (the "one before")
    await fs.writeFile(path.join(REPO, 'app.ts'), 'v1\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'c1');
    // commit 2 (HEAD) — "the latest", which `previous` must INCLUDE
    await fs.writeFile(path.join(REPO, 'app.ts'), 'v2\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'c2');
    // plus an uncommitted tweak the session makes — `previous` (HEAD~1..worktree) includes it
    await fs.writeFile(path.join(REPO, 'app.ts'), 'v3\n');
    await writeSessionJsonl(REPO, [{ file: path.join(REPO, 'app.ts'), oldStr: 'v2', newStr: 'v3' }]);

    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'previous' });
    expect(res.status).toBe(200);
    const f = res.body.groups[0].files.find((x: { relPath: string }) => x.relPath === 'app.ts');
    expect(f).toBeTruthy();
    // before = content at HEAD~1 (c1), after = current working tree (v3).
    expect(f.before).toBe('v1\n');
    expect(f.after).toBe('v3\n');
  });

  it('base=remote → only the unpushed change vs the upstream tracking branch', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    // Build a bare remote, push a baseline, set upstream.
    await git(path.dirname(REMOTE), 'init', '-q', '--bare', path.basename(REMOTE));
    await fs.writeFile(path.join(REPO, 'app.ts'), 'pushed\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'pushed');
    await git(REPO, 'remote', 'add', 'origin', REMOTE);
    await git(REPO, 'push', '-q', '-u', 'origin', 'main');
    // A LOCAL-ONLY commit (unpushed) the session makes — what `remote` mode shows.
    await fs.writeFile(path.join(REPO, 'app.ts'), 'local-only\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'unpushed');
    await writeSessionJsonl(REPO, [{ file: path.join(REPO, 'app.ts'), oldStr: 'pushed', newStr: 'local-only' }]);

    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'remote' });
    expect(res.status).toBe(200);
    const f = res.body.groups[0].files.find((x: { relPath: string }) => x.relPath === 'app.ts');
    expect(f).toBeTruthy();
    expect(f.before).toBe('pushed\n');   // upstream content
    expect(f.after).toBe('local-only\n'); // local working tree
  });

  it('base=uncommitted, session edited a file but the tree is clean for it → empty', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    await fs.writeFile(path.join(REPO, 'app.ts'), 'x\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'only');
    // Session recorded an edit, but the working tree matches HEAD (no git delta).
    await writeSessionJsonl(REPO, [{ file: path.join(REPO, 'app.ts'), oldStr: 'x', newStr: 'x' }]);

    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted' });
    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(0);
    expect(res.body.groups).toEqual([]);
  });

  it('base=previous on a single-commit repo (no HEAD~1) → 502 with a git error', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    await fs.writeFile(path.join(REPO, 'app.ts'), 'only\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'only');
    await fs.writeFile(path.join(REPO, 'app.ts'), 'only2\n');
    await writeSessionJsonl(REPO, [{ file: path.join(REPO, 'app.ts'), oldStr: 'only', newStr: 'only2' }]);

    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'previous' });
    // HEAD~1 doesn't resolve → computeSessionGitDiff throws → route maps to 502.
    expect(res.status).toBe(502);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('unknown base value falls back to the default session (JSONL) mode, not git', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    // No JSONL written → session mode yields an empty (not errored) result.
    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'bogus' });
    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(0);
  });
});

describe('GET /api/sessions/:id/changes?scope= (within the touched repos)', () => {
  it('scope=session (default) → only the files the session edited, with GIT before/after', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    await fs.writeFile(path.join(REPO, 'mine.ts'), 'const v = 1;\n');
    await fs.writeFile(path.join(REPO, 'someone-else.ts'), 'const x = 1;\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'baseline');
    // BOTH files change in the working tree (a concurrent agent touched the other)…
    await fs.writeFile(path.join(REPO, 'mine.ts'), 'const v = 2;\n');
    await fs.writeFile(path.join(REPO, 'someone-else.ts'), 'const x = 2;\n');
    // …but this session's JSONL only records editing mine.ts.
    await writeSessionJsonl(REPO, [{ file: path.join(REPO, 'mine.ts'), oldStr: 'const v = 1;', newStr: 'const v = 2;' }]);

    // default (no scope) → only mine.ts, with the GIT before/after (vs HEAD).
    const def = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted' });
    expect(def.status).toBe(200);
    expect(def.body.fileCount).toBe(1);
    const f = def.body.groups[0].files[0];
    expect(f.relPath).toBe('mine.ts');
    expect(f.before).toBe('const v = 1;\n'); // git HEAD content (not the JSONL old_string)
    expect(f.after).toBe('const v = 2;\n');

    // explicit scope=session → identical to default.
    const sess = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted', scope: 'session' });
    expect(sess.body.fileCount).toBe(1);
    expect(sess.body.groups[0].files[0].relPath).toBe('mine.ts');
  });

  it('scope=all → every change in the touched repo (incl. the sibling file the session never edited)', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    await fs.writeFile(path.join(REPO, 'mine.ts'), 'const v = 1;\n');
    await fs.writeFile(path.join(REPO, 'someone-else.ts'), 'const x = 1;\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'baseline');
    await fs.writeFile(path.join(REPO, 'mine.ts'), 'const v = 2;\n');
    await fs.writeFile(path.join(REPO, 'someone-else.ts'), 'const x = 2;\n');
    await writeSessionJsonl(REPO, [{ file: path.join(REPO, 'mine.ts'), oldStr: 'const v = 1;', newStr: 'const v = 2;' }]);

    const all = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted', scope: 'all' });
    expect(all.status).toBe(200);
    const allPaths = all.body.groups.flatMap((g: { files: { relPath: string }[] }) => g.files.map((f) => f.relPath)).sort();
    expect(allPaths).toEqual(['mine.ts', 'someone-else.ts']);
  });

  it('scope=all is STILL bounded to touched repos: a session that edited nothing → empty', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    await fs.writeFile(path.join(REPO, 'repo-file.ts'), 'a\n');
    await git(REPO, 'add', '-A');
    await git(REPO, 'commit', '-q', '-m', 'baseline');
    await fs.writeFile(path.join(REPO, 'repo-file.ts'), 'b\n'); // dirty, but session edited nothing

    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ base: 'uncommitted', scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(0);
    expect(res.body.groups).toEqual([]);
  });

  it('scope is ignored for base=session (already session-scoped)', async () => {
    await createSessionRecord(SID, 'task-1', 'proj', REPO);
    await fs.writeFile(path.join(REPO, 'mine.ts'), 'const v = 2;\n');
    await writeSessionJsonl(REPO, [{ file: path.join(REPO, 'mine.ts'), oldStr: 'const v = 1;', newStr: 'const v = 2;' }]);

    // base defaults to 'session'; scope=all must NOT trip the git path.
    const res = await request(createApp()).get(`/api/sessions/${SID}/changes`).query({ scope: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(1);
    expect(res.body.groups[0].files[0].relPath).toBe('mine.ts');
  });
});
