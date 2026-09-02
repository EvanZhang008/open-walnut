/**
 * Sync precondition probes: async, cached, single-flight.
 *
 * autoSync() (the ~30s git tick) and gitPullWalnut() (every session:result /
 * session:error) both open with the same triple — is git installed, is the data
 * dir a repo, does it have a remote — and all three used to run through the
 * SYNCHRONOUS gitSafe()/execSync. A production CPU profile caught the trio as one
 * 175ms burst of frozen event loop, which stalls EVERY HTTP route.
 *
 * What these tests pin:
 *  - N concurrent callers share ONE child process per probe;
 *  - answers are reused, so a second tick pays nothing;
 *  - the branch name is NOT cached (a checkout must be seen immediately);
 *  - the cache is invalidated by the two mutation points (initSync creates the
 *    repo, setRemote adds the remote), so sync starts working right after setup
 *    instead of after a restart or a TTL expiry;
 *  - a NEGATIVE git-availability answer expires, so installing git later does
 *    not need a restart, while a positive one is kept forever;
 *  - the hot paths make ZERO execSync calls (the actual regression ratchet);
 *  - all three missing preconditions still no-op cleanly and never throw.
 *
 * child_process is fully mocked: nothing here may run a real git, and nothing
 * may reach the developer's real data dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-probe-cache-test'));

const h = vi.hoisted(() => ({
  /** Every git command handed to spawn, in order. */
  spawned: [] as string[],
  /** Every command handed to the blocking execSync — must stay EMPTY on hot paths. */
  execSyncCalls: [] as string[],
  /** Commands handed to the async exec (credential-guard probe). */
  execCalls: [] as string[],
  // Fake machine state the probes read.
  gitAvailable: true,
  isRepo: true,
  hasRemote: true,
  /** When set, matching commands are parked in `pending` instead of finishing. */
  holdNeedle: null as string | null,
  pending: [] as Array<{ cmd: string; finish: (stdout: string, code?: number) => void }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');

  /** Canned outcome for one git command line. */
  const answer = (cmd: string): { code: number; stdout: string } => {
    if (cmd.includes('--version')) {
      return h.gitAvailable ? { code: 0, stdout: 'git version 2.99.0\n' } : { code: 127, stdout: '' };
    }
    if (cmd.includes('rev-parse --is-inside-work-tree')) {
      return h.isRepo ? { code: 0, stdout: 'true\n' } : { code: 128, stdout: '' };
    }
    if (/\bgit remote$/.test(cmd.trim())) {
      if (!h.isRepo) return { code: 128, stdout: '' };
      return { code: 0, stdout: h.hasRemote ? 'origin\n' : '' };
    }
    if (cmd.includes('rev-parse --abbrev-ref HEAD')) return { code: 0, stdout: 'main\n' };
    // Everything else (ls-files, status, pull, push…): succeed with no output,
    // which is the "clean tree, nothing to do" shape.
    return { code: 0, stdout: '' };
  };

  const spawn: any = vi.fn((file: string, args: readonly string[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const cmd = file === '/bin/sh' ? (args[1] ?? '') : `${file} ${args.join(' ')}`;
    h.spawned.push(cmd);

    const child: any = new EventEmitter(); // eslint-disable-line @typescript-eslint/no-explicit-any
    child.pid = 4242;
    const mkStream = (): any => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const s: any = new EventEmitter(); // eslint-disable-line @typescript-eslint/no-explicit-any
      s.setEncoding = () => s;
      return s;
    };
    child.stdout = mkStream();
    child.stderr = mkStream();

    const finish = (stdout: string, code = 0): void => {
      if (stdout) child.stdout.emit('data', stdout);
      child.emit('close', code);
    };
    if (h.holdNeedle !== null && cmd.includes(h.holdNeedle)) {
      h.pending.push({ cmd, finish });
      return child;
    }
    const canned = answer(cmd);
    setImmediate(() => finish(canned.stdout, canned.code));
    return child;
  });

  // promisify(exec) is what credentialGuardArgsAsync uses; give it the custom
  // hook so it resolves the { stdout } shape the real one does.
  const exec: any = (cmd: string, _opts?: unknown, cb?: unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    h.execCalls.push(cmd);
    const done = (typeof _opts === 'function' ? _opts : cb) as
      ((e: Error | null, o: string, s: string) => void) | undefined;
    setImmediate(() => done?.(null, '', ''));
    return new EventEmitter();
  };
  exec[Symbol.for('nodejs.util.promisify.custom')] = async (cmd: string) => {
    h.execCalls.push(cmd);
    return { stdout: '', stderr: '' };
  };

  return {
    ...actual,
    spawn,
    exec,
    // The blocking helpers stay in the file for one-shot/CLI callers. Mocked so a
    // test can never shell out for real, and COUNTED so the hot paths can assert
    // they touched none of them.
    execSync: vi.fn((cmd: string) => {
      h.execSyncCalls.push(cmd);
      // Faithful to the real machine: these are the commands that CREATE the two
      // facts the probes cache, and they only ever run through the sync helpers.
      if (/\bgit init\b/.test(cmd)) h.isRepo = true;
      if (/\bremote (add|set-url)\b/.test(cmd)) h.hasRemote = true;
      const canned = answer(cmd);
      if (canned.code !== 0) throw new Error(`mock git exited ${canned.code}: ${cmd}`);
      return canned.stdout;
    }),
  };
});

import { WALNUT_HOME } from '../../src/constants.js';
import {
  autoSync,
  gitPullWalnut,
  hasRemoteAsync,
  isRepoAsync,
  isGitAvailableAsync,
  getLastSyncAtAsync,
  initSync,
  setRemote,
  invalidateSyncProbeCache,
  resetSyncProbeCacheForTest,
  resetLastSyncCacheForTest,
  SYNC_PROBE_TTL_MS,
} from '../../src/integrations/git-sync.js';

/** How many spawned commands matched a needle. */
const count = (needle: string | RegExp): number =>
  h.spawned.filter((c) => (typeof needle === 'string' ? c.includes(needle) : needle.test(c))).length;

const REMOTE_PROBE = /\bgit remote$/;
const REPO_PROBE = 'rev-parse --is-inside-work-tree';
const VERSION_PROBE = '--version';

beforeEach(() => {
  h.spawned.length = 0;
  h.execSyncCalls.length = 0;
  h.execCalls.length = 0;
  h.pending.length = 0;
  h.holdNeedle = null;
  h.gitAvailable = true;
  h.isRepo = true;
  h.hasRemote = true;
  resetSyncProbeCacheForTest();
  resetLastSyncCacheForTest();
  // initSync writes .gitignore into WALNUT_HOME; the mock constants point at a
  // temp dir that does not exist yet.
  fs.mkdirSync(WALNUT_HOME, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('precondition probes: single-flight', () => {
  it('eight concurrent hasRemoteAsync callers share ONE `git remote` process', async () => {
    const answers = await Promise.all(Array.from({ length: 8 }, () => hasRemoteAsync()));
    expect(answers).toEqual(Array(8).fill(true));
    expect(count(REMOTE_PROBE)).toBe(1);
  });

  it('eight concurrent isRepoAsync callers share ONE rev-parse', async () => {
    const answers = await Promise.all(Array.from({ length: 8 }, () => isRepoAsync()));
    expect(answers).toEqual(Array(8).fill(true));
    expect(count(REPO_PROBE)).toBe(1);
  });

  it('eight concurrent autoSync/gitPullWalnut callers still probe each fact once', async () => {
    await Promise.all([
      autoSync(), gitPullWalnut(), autoSync(), gitPullWalnut(),
      autoSync(), gitPullWalnut(), autoSync(), gitPullWalnut(),
    ]);
    expect(count(VERSION_PROBE)).toBe(1);
    expect(count(REPO_PROBE)).toBe(1);
    expect(count(REMOTE_PROBE)).toBe(1);
  });

  it('reuses the answers on the next tick (a probe is not re-run per tick)', async () => {
    await autoSync();
    const afterFirst = { v: count(VERSION_PROBE), r: count(REPO_PROBE), o: count(REMOTE_PROBE) };
    expect(afterFirst).toEqual({ v: 1, r: 1, o: 1 });

    await autoSync();
    expect(count(VERSION_PROBE)).toBe(1);
    expect(count(REPO_PROBE)).toBe(1);
    expect(count(REMOTE_PROBE)).toBe(1);
    // …but the branch is deliberately NOT cached: a checkout between ticks must
    // be seen, or the tick would push the wrong ref.
    expect(count('rev-parse --abbrev-ref HEAD')).toBe(2);
  });
});

describe('precondition probes: nothing blocking on the hot paths', () => {
  it('autoSync makes ZERO execSync calls', async () => {
    await autoSync();
    expect(h.execSyncCalls).toEqual([]);
    // …and it did do the real work, so the assertion above is not vacuous.
    expect(count('pull --rebase origin main')).toBe(1);
  });

  it('gitPullWalnut makes ZERO execSync calls', async () => {
    await gitPullWalnut();
    expect(h.execSyncCalls).toEqual([]);
    expect(count('pull --ff-only')).toBe(1);
  });

  it('getLastSyncAtAsync makes ZERO execSync calls', async () => {
    await getLastSyncAtAsync();
    expect(h.execSyncCalls).toEqual([]);
    expect(count('log -1 --format=%aI')).toBe(1);
    // Shared 30s cache with the sync twin — a second call costs nothing.
    await getLastSyncAtAsync();
    expect(count('log -1 --format=%aI')).toBe(1);
  });
});

describe('precondition probes: missing preconditions no-op cleanly', () => {
  it('git missing → no sync work, and the later probes are never even run', async () => {
    h.gitAvailable = false;
    await expect(autoSync()).resolves.toBeUndefined();
    expect(count(VERSION_PROBE)).toBe(1);
    // Same short-circuit as the old `!isGitAvailable() || !isRepo() || …`.
    expect(count(REPO_PROBE)).toBe(0);
    expect(count(REMOTE_PROBE)).toBe(0);
    expect(count('pull')).toBe(0);
    expect(count('push')).toBe(0);
  });

  it('not a repo → no sync work, no push', async () => {
    h.isRepo = false;
    await expect(autoSync()).resolves.toBeUndefined();
    await expect(gitPullWalnut()).resolves.toBeUndefined();
    expect(count(REPO_PROBE)).toBe(1);
    expect(count(REMOTE_PROBE)).toBe(0);
    expect(count('pull')).toBe(0);
    expect(count('push')).toBe(0);
  });

  it('no remote → no pull, no push', async () => {
    h.hasRemote = false;
    await expect(autoSync()).resolves.toBeUndefined();
    await expect(gitPullWalnut()).resolves.toBeUndefined();
    expect(count(REMOTE_PROBE)).toBe(1);
    expect(count('pull')).toBe(0);
    expect(count('push')).toBe(0);
  });
});

describe('precondition probes: invalidation', () => {
  it('setRemote() lets the very next tick sync — no restart, no TTL wait', async () => {
    h.hasRemote = false;
    await autoSync();
    expect(count('pull')).toBe(0);

    // The user configures a remote. setRemote goes through the sync helpers (CLI
    // / one-shot path) and must drop the cached "no remote" answer.
    setRemote('https://example.invalid/git/data');
    h.spawned.length = 0;

    await autoSync();
    expect(count(REMOTE_PROBE)).toBe(1);
    expect(count('pull --rebase origin main')).toBe(1);
  });

  it('without invalidation the stale answer would persist — the TTL alone is not the fix', async () => {
    h.hasRemote = false;
    await autoSync();
    h.hasRemote = true;
    h.spawned.length = 0;

    // No invalidation: inside the TTL the tick keeps standing down. This is what
    // makes the explicit invalidation above load-bearing rather than decorative.
    await autoSync();
    expect(count(REMOTE_PROBE)).toBe(0);
    expect(count('pull')).toBe(0);
  });

  it('initSync() lets the very next tick sync after the repo is created', async () => {
    h.isRepo = false;
    h.hasRemote = false;
    await autoSync();
    expect(count('pull')).toBe(0);

    // First-run setup: `git init` + `remote add` inside initSync are what make
    // both cached answers wrong, and both must be dropped.
    initSync('https://example.invalid/git/data');
    expect(h.isRepo).toBe(true);
    expect(h.hasRemote).toBe(true);
    h.spawned.length = 0;

    await autoSync();
    expect(count(REPO_PROBE)).toBe(1);
    expect(count(REMOTE_PROBE)).toBe(1);
    expect(count('pull --rebase origin main')).toBe(1);
  });

  it('an invalidation during an in-flight probe discards that probe’s stale answer', async () => {
    // Park the `git remote` probe so the mutation lands while it is still running.
    h.holdNeedle = 'git remote';
    h.hasRemote = false;
    const first = hasRemoteAsync();
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));

    h.hasRemote = true;
    invalidateSyncProbeCache();

    // The parked probe now answers with the PRE-mutation truth.
    h.holdNeedle = null;
    h.pending.shift()!.finish('');
    expect(await first).toBe(false);

    // A caller arriving after the mutation must re-probe, not inherit that answer.
    expect(await hasRemoteAsync()).toBe(true);
    expect(count(REMOTE_PROBE)).toBe(2);
  });
});

describe('precondition probes: git availability caching policy', () => {
  it('a NEGATIVE answer expires, so installing git later needs no restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    h.gitAvailable = false;

    await autoSync();
    await autoSync();
    // Inside the TTL the negative answer is reused (no spawn storm)…
    expect(count(VERSION_PROBE)).toBe(1);

    vi.setSystemTime(Date.now() + SYNC_PROBE_TTL_MS + 1_000);
    h.gitAvailable = true;
    await autoSync();

    // …and once it expires the probe runs again and sync comes back to life.
    expect(count(VERSION_PROBE)).toBe(2);
    expect(count('pull --rebase origin main')).toBe(1);
  });

  it('a POSITIVE answer is kept forever — git does not leave PATH mid-process', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await autoSync();
    expect(count(VERSION_PROBE)).toBe(1);

    vi.setSystemTime(Date.now() + SYNC_PROBE_TTL_MS * 100);
    await autoSync();
    expect(count(VERSION_PROBE)).toBe(1);
  });

  it('isGitAvailableAsync answers false without throwing when git is missing', async () => {
    h.gitAvailable = false;
    await expect(isGitAvailableAsync()).resolves.toBe(false);
    h.gitAvailable = true;
    resetSyncProbeCacheForTest();
    await expect(isGitAvailableAsync()).resolves.toBe(true);
  });
});
