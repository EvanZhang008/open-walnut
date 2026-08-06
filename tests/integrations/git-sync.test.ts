import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

// Mock constants to redirect to temp directory
vi.mock('../../src/constants.js', () => createMockConstants());

import {
  isGitAvailable,
  getSyncStatus,
  initSync,
  sync,
  setRemote,
  ensureRepo,
  ensureCriticalIgnores,
  ensureMachineLocalUntracked,
  credentialGuardArgs,
  credentialGuardArgsAsync,
  clearStaleLock,
  isLockContention,
  hardenGitConfigPerms,
} from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('isGitAvailable', () => {
  it('returns true when git is installed', () => {
    expect(isGitAvailable()).toBe(true);
  });
});

describe('getSyncStatus', () => {
  it('returns not initialized when no git repo', () => {
    const status = getSyncStatus();
    expect(status.initialized).toBe(false);
    expect(status.remoteConfigured).toBe(false);
    expect(status.lastSyncAt).toBeNull();
    expect(status.pendingChanges).toBe(0);
    expect(status.branch).toBe('main');
  });

  it('returns initialized after initSync', () => {
    initSync();
    const status = getSyncStatus();
    expect(status.initialized).toBe(true);
    expect(status.branch).toBe('main');
    expect(status.remoteConfigured).toBe(false);
  });
});

describe('initSync', () => {
  it('creates a git repo in WALNUT_HOME', () => {
    initSync();
    // Verify .git directory exists
    const result = execSync('git rev-parse --is-inside-work-tree', {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
    expect(result).toBe('true');
  });

  it('creates .gitignore', async () => {
    initSync();
    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('ms-todo-tokens.json');
  });

  it('creates initial commit', () => {
    initSync();
    const log = execSync('git log --oneline -1', {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
    expect(log).toContain('walnut init');
  });

  it('is idempotent - can be called twice', () => {
    initSync();
    initSync(); // Should not throw
    const status = getSyncStatus();
    expect(status.initialized).toBe(true);
  });
});

describe('sync', () => {
  it('commits pending changes', async () => {
    initSync();

    // Create a new file to trigger a commit
    await fsp.writeFile(path.join(tmpDir, 'test-file.txt'), 'test content');

    const result = await sync();
    // Should have committed the change (pushed=1 means commit was created)
    expect(result.pushed).toBe(1);
    expect(result.conflicts).toBe(0);
  });

  it('reports no changes when repo is clean', async () => {
    initSync();

    const result = await sync();
    // No new files, so no push
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(0);
    expect(result.conflicts).toBe(0);
  });

  it('shows zero pending after sync', async () => {
    initSync();
    await fsp.writeFile(path.join(tmpDir, 'pending.txt'), 'data');

    await sync();

    const status = getSyncStatus();
    expect(status.pendingChanges).toBe(0);
  });
});

describe('auth.json is never synced (data-repo gitignore)', () => {
  it('fresh initSync writes a .gitignore that excludes auth.json', async () => {
    initSync();
    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore.split('\n')).toContain('auth.json');
  });

  it('ensureCriticalIgnores appends auth.json to a pre-existing .gitignore (idempotent)', async () => {
    // Simulate an older installation whose .gitignore predates device auth.
    initSync();
    await fsp.writeFile(path.join(tmpDir, '.gitignore'), 'images/\n*.log\n', 'utf-8');

    ensureCriticalIgnores();
    const once = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(once.split('\n')).toContain('auth.json');

    ensureCriticalIgnores();
    const twice = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(twice).toBe(once); // no duplicate append
  });

  it('ensureRepo self-heals an existing repo missing the auth.json ignore', async () => {
    initSync();
    await fsp.writeFile(path.join(tmpDir, '.gitignore'), 'images/\n', 'utf-8');

    const result = ensureRepo();
    expect(result.available).toBe(true);
    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore.split('\n')).toContain('auth.json');
  });

  it('ensureCriticalIgnores also protects config.yaml (machine-local settings)', async () => {
    initSync();
    await fsp.writeFile(path.join(tmpDir, '.gitignore'), 'images/\n', 'utf-8');

    ensureCriticalIgnores();
    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore.split('\n')).toContain('config.yaml');
  });

  // ── 2026-07-25 incident: a remote deletion of a TRACKED-but-ignored
  // config.yaml wiped the local file, taking the `stt:` section with it —
  // voice input went grey with "No STT engine configured".
  // .gitignore alone does NOT protect an already-tracked path.
  it('ensureMachineLocalUntracked drops a tracked config.yaml from the index but keeps it on disk', async () => {
    initSync();
    const configPath = path.join(tmpDir, 'config.yaml');
    await fsp.writeFile(configPath, 'stt:\n  engine: whisper-server\n', 'utf-8');
    // Tracked BEFORE the ignore rule existed — the dangerous legacy state.
    execSync('git add -f config.yaml && git commit -q -m "legacy: config tracked"', { cwd: tmpDir });
    ensureCriticalIgnores();

    const untracked = ensureMachineLocalUntracked();

    expect(untracked).toContain('config.yaml');
    expect(execSync('git ls-files', { cwd: tmpDir, encoding: 'utf-8' }).split('\n'))
      .not.toContain('config.yaml');
    // The user's live settings must survive untouched.
    expect(await fsp.readFile(configPath, 'utf-8')).toContain('engine: whisper-server');
  });

  it('ensureMachineLocalUntracked is a no-op when nothing ignored is tracked', () => {
    initSync();
    ensureCriticalIgnores();
    expect(ensureMachineLocalUntracked()).toEqual([]);
  });

  it('a pulled deletion of config.yaml cannot wipe the local file once untracked', async () => {
    // Reproduces the incident end to end: remote deletes config.yaml, we merge.
    const remoteDir = path.join(path.dirname(tmpDir), `remote-${path.basename(tmpDir)}`);
    await fsp.rm(remoteDir, { recursive: true, force: true });
    await fsp.mkdir(remoteDir, { recursive: true });
    execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: remoteDir });
    await fsp.writeFile(path.join(remoteDir, 'config.yaml'), 'stt:\n  engine: whisper-server\n', 'utf-8');
    await fsp.writeFile(path.join(remoteDir, 'notes.md'), 'shared\n', 'utf-8');
    execSync('git add -A && git commit -q -m init', { cwd: remoteDir });

    execSync(`git clone -q "${remoteDir}" "${tmpDir}-clone"`, { cwd: path.dirname(tmpDir) });
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.rename(`${tmpDir}-clone`, tmpDir);
    execSync('git config user.email t@t && git config user.name t', { cwd: tmpDir });

    // Protect the machine-local file the way ensureRepo() now does on boot.
    await fsp.writeFile(path.join(tmpDir, '.gitignore'), 'config.yaml\n', 'utf-8');
    ensureMachineLocalUntracked();
    execSync('git add -A && git commit -q -m "untrack machine-local config"', { cwd: tmpDir });

    // Remote (another box) deletes it and we pull that deletion.
    execSync('git rm -q --cached config.yaml && git commit -q -m "untrack on remote"', { cwd: remoteDir });
    execSync('git pull -q --no-rebase --no-edit origin main', { cwd: tmpDir });

    // The live settings must still be there.
    const onDisk = await fsp.readFile(path.join(tmpDir, 'config.yaml'), 'utf-8');
    expect(onDisk).toContain('engine: whisper-server');

    await fsp.rm(remoteDir, { recursive: true, force: true });
  });

  // ── 2026-07-26 recurrence: the boot-time guard (ensureRepo) is not enough.
  // A merge runs every 30s, so a critical file that re-enters the index at
  // RUNTIME — e.g. tracked by `add -A` before .gitignore covered it — is
  // exposed until the next restart. sync() must re-check before every pull.
  it('sync() untracks a machine-local file that re-entered the index at runtime, before pulling', async () => {
    initSync();
    const configPath = path.join(tmpDir, 'config.yaml');
    await fsp.writeFile(configPath, 'hosts:\n  marina:\n    hostname: box\n', 'utf-8');
    // The runtime-exposure state: tracked despite being ignored. `-f` mimics an
    // `add -A` that ran while the ignore rule was still missing.
    execSync('git add -f config.yaml && git commit -q -m "runtime: config re-tracked"', { cwd: tmpDir });
    expect(execSync('git ls-files', { cwd: tmpDir, encoding: 'utf-8' })).toContain('config.yaml');

    await sync();

    expect(execSync('git ls-files', { cwd: tmpDir, encoding: 'utf-8' }).split('\n'))
      .not.toContain('config.yaml');
    // The user's live settings must never be touched — index only.
    expect(await fsp.readFile(configPath, 'utf-8')).toContain('marina');
  });

  it('sync never commits auth.json', async () => {
    initSync();
    await fsp.writeFile(path.join(tmpDir, 'auth.json'), '{"devices":[]}', 'utf-8');
    await fsp.writeFile(path.join(tmpDir, 'normal.txt'), 'data', 'utf-8');

    await sync();

    const tracked = execSync('git ls-files', { cwd: tmpDir, encoding: 'utf-8' });
    expect(tracked).toContain('normal.txt');
    expect(tracked.split('\n')).not.toContain('auth.json');
  });
});

// ── Credential-helper guard (token-in-URL remotes must not touch helpers) ──

describe('credentialGuardArgs', () => {
  it('returns the helper-neutralizing flag when the remote URL embeds credentials', () => {
    initSync();
    setRemote('https://walnut:deadbeef00112233@cloud.example.com/git/data');
    expect(credentialGuardArgs(tmpDir)).toEqual(['-c', 'credential.helper=']);
  });

  it('returns nothing when the remote URL has no credentials (helper may be the only auth source)', () => {
    initSync();
    setRemote('https://cloud.example.com/git/data');
    expect(credentialGuardArgs(tmpDir)).toEqual([]);
  });

  it('returns nothing when there is no remote at all', () => {
    initSync();
    expect(credentialGuardArgs(tmpDir)).toEqual([]);
  });

  it('returns nothing outside a git repo', () => {
    expect(credentialGuardArgs(tmpDir)).toEqual([]);
  });

  // The async tick path called the execSync-based sync version on every network
  // op, blocking the event loop (all HTTP requests stalled) once per fetch/push.
  it('async variant agrees with the sync one on a credentialed remote', async () => {
    initSync();
    setRemote('https://walnut:deadbeef00112233@cloud.example.com/git/data');
    await expect(credentialGuardArgsAsync(tmpDir)).resolves.toEqual(['-c', 'credential.helper=']);
  });

  it('async variant returns nothing when the remote has no credentials', async () => {
    initSync();
    setRemote('https://cloud.example.com/git/data');
    await expect(credentialGuardArgsAsync(tmpDir)).resolves.toEqual([]);
  });
});

// Regression: a stale refs/remotes/origin/main.lock (crashed git, no owning
// process) sat for 2.5 days and failed all 246 sync ticks. Only index.lock was
// ever cleaned, and isLockContention() only matched index.lock — so the
// self-heal retry never fired and the UI stalled on every retry.
describe('stale git lock recovery', () => {
  const REF_LOCK = ['refs', 'remotes', 'origin', 'main.lock'];

  const writeLock = async (parts: string[], ageMs: number): Promise<string> => {
    const full = path.join(tmpDir, '.git', ...parts);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, '');
    const when = new Date(Date.now() - ageMs);
    await fsp.utimes(full, when, when);
    return full;
  };

  it('clears a stale REF lock, not just index.lock', async () => {
    initSync();
    const refLock = await writeLock(REF_LOCK, 10 * 60_000);

    expect(clearStaleLock()).toBe(true);
    await expect(fsp.stat(refLock)).rejects.toThrow();
  });

  it('clears a stale index.lock (existing behavior preserved)', async () => {
    initSync();
    const indexLock = await writeLock(['index.lock'], 10 * 60_000);

    expect(clearStaleLock()).toBe(true);
    await expect(fsp.stat(indexLock)).rejects.toThrow();
  });

  it('leaves a FRESH lock alone — a live git op must not be sabotaged', async () => {
    initSync();
    const refLock = await writeLock(REF_LOCK, 2_000);
    const indexLock = await writeLock(['index.lock'], 2_000);

    expect(clearStaleLock()).toBe(false);
    await expect(fsp.stat(refLock)).resolves.toBeDefined();
    await expect(fsp.stat(indexLock)).resolves.toBeDefined();
  });

  it('clears nested ref locks (tags, multi-segment branch names)', async () => {
    initSync();
    const nested = await writeLock(['refs', 'remotes', 'origin', 'feature', 'a', 'b.lock'], 10 * 60_000);

    expect(clearStaleLock()).toBe(true);
    await expect(fsp.stat(nested)).rejects.toThrow();
  });

  it('clears stale top-level pseudo-ref locks (AUTO_MERGE.lock etc.)', async () => {
    // A merge killed mid-run (execGitGroup timeout) leaves AUTO_MERGE.lock;
    // every later merge then fails "cannot lock ref" — observed 2026-08 as a
    // two-day `pull -X theirs` fallback loop on every 30s tick.
    initSync();
    const autoMerge = await writeLock(['AUTO_MERGE.lock'], 10 * 60_000);
    const mergeHead = await writeLock(['MERGE_HEAD.lock'], 10 * 60_000);

    expect(clearStaleLock()).toBe(true);
    await expect(fsp.stat(autoMerge)).rejects.toThrow();
    await expect(fsp.stat(mergeHead)).rejects.toThrow();
  });

  it('leaves a fresh AUTO_MERGE.lock alone (live merge in progress)', async () => {
    initSync();
    const autoMerge = await writeLock(['AUTO_MERGE.lock'], 2_000);

    expect(clearStaleLock()).toBe(false);
    await expect(fsp.stat(autoMerge)).resolves.toBeDefined();
  });

  it('is a no-op when there are no locks', () => {
    initSync();
    expect(clearStaleLock()).toBe(false);
  });

  it('isLockContention matches ref-lock errors, not just index.lock', () => {
    const refErr = new Error(
      "error: cannot lock ref 'refs/remotes/origin/main': Unable to create " +
        "'/home/u/.open-walnut/.git/refs/remotes/origin/main.lock': File exists.",
    );
    const indexErr = new Error(
      "fatal: Unable to create '/home/u/.open-walnut/.git/index.lock': File exists.",
    );

    expect(isLockContention(refErr)).toBe(true);
    expect(isLockContention(indexErr)).toBe(true);
  });

  it('isLockContention does NOT match real network failures', () => {
    expect(isLockContention(new Error('fatal: unable to access ... Could not resolve host'))).toBe(false);
    expect(isLockContention(new Error('fatal: Authentication failed'))).toBe(false);
    expect(isLockContention(new Error('Command failed: git fetch origin main'))).toBe(false);
  });
});

describe('hardenGitConfigPerms', () => {
  it('setRemote with a credentialed URL tightens .git/config to 0600', async () => {
    initSync();
    setRemote('https://walnut:deadbeef00112233@cloud.example.com/git/data');
    const stat = await fsp.stat(path.join(tmpDir, '.git', 'config'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('setRemote with a plain URL leaves permissions alone', async () => {
    initSync();
    const before = (await fsp.stat(path.join(tmpDir, '.git', 'config'))).mode & 0o777;
    setRemote('https://cloud.example.com/git/data');
    const after = (await fsp.stat(path.join(tmpDir, '.git', 'config'))).mode & 0o777;
    expect(after).toBe(before);
  });

  it('never throws when .git/config is missing', () => {
    expect(() => hardenGitConfigPerms('https://u:t@h/x', tmpDir)).not.toThrow();
  });
});

// ── LWW conflict policy (two real clones of a shared bare origin) ──

describe('sync conflict policy (LWW with history)', () => {
  let bareDir: string;
  let cloneDir: string;
  let conflictEvents: Array<{ files: string[]; winner: 'local' | 'remote'; losingCommit: string }>;

  function run(cmd: string, cwd: string, env?: Record<string, string>): string {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : undefined,
    }).trim();
  }

  /** Commit everything in `cwd`; optional ISO date controls the committer time (LWW input). */
  function commitAll(cwd: string, message: string, dateIso?: string): void {
    run('git add -A', cwd);
    const env = dateIso ? { GIT_COMMITTER_DATE: dateIso, GIT_AUTHOR_DATE: dateIso } : undefined;
    run(`git commit -m "${message}"`, cwd, env);
  }

  beforeEach(async () => {
    bareDir = `${tmpDir}-origin.git`;
    cloneDir = `${tmpDir}-clone`;
    await fsp.rm(bareDir, { recursive: true, force: true });
    await fsp.rm(cloneDir, { recursive: true, force: true });
    await fsp.mkdir(bareDir, { recursive: true });

    // Shared origin + local repo (WALNUT_HOME) + a second "cloud box" clone.
    run('git init --bare -b main', bareDir);
    initSync();
    run('git config user.email local@test.local', tmpDir);
    run('git config user.name local-box', tmpDir);
    setRemote(bareDir);
    await fsp.writeFile(
      path.join(tmpDir, 'data.txt'),
      'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n',
      'utf-8',
    );
    commitAll(tmpDir, 'base');
    run('git push origin main', tmpDir);
    run(`git clone "${bareDir}" "${cloneDir}"`, tmpDir);
    run('git config user.email cloud@test.local', cloneDir);
    run('git config user.name cloud-box', cloneDir);

    conflictEvents = [];
    bus.subscribe('web-ui', (event) => {
      if (event.name === 'sync:conflict-resolved') {
        conflictEvents.push(event.data as (typeof conflictEvents)[number]);
      }
    });
  });

  afterEach(async () => {
    bus.unsubscribe('web-ui');
    await fsp.rm(bareDir, { recursive: true, force: true });
    await fsp.rm(cloneDir, { recursive: true, force: true });
  });

  it('different lines of the same file merge silently — both changes kept, no conflict event', async () => {
    // Remote box edits line 1; local edits line 10 — non-overlapping hunks.
    const remoteContent = 'REMOTE-EDIT\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n';
    await fsp.writeFile(path.join(cloneDir, 'data.txt'), remoteContent, 'utf-8');
    commitAll(cloneDir, 'remote edit line 1');
    run('git push origin main', cloneDir);

    await fsp.writeFile(
      path.join(tmpDir, 'data.txt'),
      'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nLOCAL-EDIT\n',
      'utf-8',
    );

    const result = await sync();

    expect(result.conflicts).toBe(0);
    const merged = await fsp.readFile(path.join(tmpDir, 'data.txt'), 'utf-8');
    expect(merged).toContain('REMOTE-EDIT');
    expect(merged).toContain('LOCAL-EDIT');
    expect(conflictEvents).toHaveLength(0);
  });

  it('same-line conflict, REMOTE newer → remote wins; merge commit keeps losing version recoverable; event emitted', async () => {
    const past = new Date(Date.now() - 120_000).toISOString();

    // Local edit committed 2 min ago (pre-committed so sync() won't re-stamp it).
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'LOCAL-VERSION\n', 'utf-8');
    commitAll(tmpDir, 'local edit', past);
    const localHeadBefore = run('git rev-parse HEAD', tmpDir);

    // Remote edit committed NOW (newer) on the same line.
    await fsp.writeFile(path.join(cloneDir, 'data.txt'), 'REMOTE-VERSION\n', 'utf-8');
    commitAll(cloneDir, 'remote edit');
    run('git push origin main', cloneDir);

    const result = await sync();

    // Newer side (remote) won the working tree.
    expect(result.conflicts).toBeGreaterThan(0);
    const content = await fsp.readFile(path.join(tmpDir, 'data.txt'), 'utf-8');
    expect(content).toBe('REMOTE-VERSION\n');

    // True merge commit: two parents, LWW message.
    const parents = run('git rev-list --parents -1 HEAD', tmpDir).split(/\s+/);
    expect(parents).toHaveLength(3); // self + 2 parents
    expect(run('git log -1 --format=%s', tmpDir)).toContain('LWW conflict resolution');

    // Losing version is recoverable from history via the losing commit.
    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0].winner).toBe('remote');
    expect(conflictEvents[0].files).toEqual(['data.txt']);
    expect(conflictEvents[0].losingCommit).toBe(localHeadBefore);
    const losing = run(`git show ${conflictEvents[0].losingCommit}:data.txt`, tmpDir);
    expect(losing).toBe('LOCAL-VERSION');
    // Documented recovery path reaches the losing commit (--full-history is
    // required: plain `git log -- <file>` simplifies away the losing parent).
    const history = run('git log --all --full-history --format=%H -- data.txt', tmpDir);
    expect(history).toContain(localHeadBefore);
  });

  it('same-line conflict, LOCAL newer → local wins (directional, not always-remote)', async () => {
    const past = new Date(Date.now() - 120_000).toISOString();

    // Remote edit committed 2 min ago.
    await fsp.writeFile(path.join(cloneDir, 'data.txt'), 'REMOTE-VERSION\n', 'utf-8');
    commitAll(cloneDir, 'remote edit', past);
    run('git push origin main', cloneDir);
    const remoteHead = run('git rev-parse HEAD', cloneDir);

    // Local edit left dirty — sync() commits it NOW (newer), proving the
    // commit-before-merge guarantee also covers uncommitted saves.
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'LOCAL-VERSION\n', 'utf-8');

    const result = await sync();

    expect(result.conflicts).toBeGreaterThan(0);
    const content = await fsp.readFile(path.join(tmpDir, 'data.txt'), 'utf-8');
    expect(content).toBe('LOCAL-VERSION\n');

    expect(conflictEvents).toHaveLength(1);
    expect(conflictEvents[0].winner).toBe('local');
    expect(conflictEvents[0].losingCommit).toBe(remoteHead);
    const losing = run(`git show ${remoteHead}:data.txt`, tmpDir);
    expect(losing).toBe('REMOTE-VERSION');
  });

  it('clean fast-forward pull stays linear — no merge commit, no conflict event', async () => {
    await fsp.writeFile(path.join(cloneDir, 'newfile.txt'), 'from remote\n', 'utf-8');
    commitAll(cloneDir, 'remote adds file');
    run('git push origin main', cloneDir);

    const result = await sync();

    expect(result.pulled).toBe(1);
    expect(result.conflicts).toBe(0);
    const content = await fsp.readFile(path.join(tmpDir, 'newfile.txt'), 'utf-8');
    expect(content).toBe('from remote\n');
    // Single-parent head — no merge commit spam on the happy path.
    const parents = run('git rev-list --parents -1 HEAD', tmpDir).split(/\s+/);
    expect(parents).toHaveLength(2); // self + 1 parent
    expect(conflictEvents).toHaveLength(0);
  });
});
