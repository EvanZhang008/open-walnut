/**
 * gitPullWalnut single-flight + async conversion.
 *
 * session:result and session:error handlers both call gitPullWalnut() and can
 * fire together: two parallel pulls would collide on .git/index.lock.
 * Concurrent callers must share ONE in-flight pull. Its network half is one
 * `git fetch` (the working tree then moves through git-sync-apply.ts, never a
 * `git pull`), so the fetch is what these tests count and hold open.
 *
 * child_process is mocked so we can count the underlying git invocations and
 * hold the fetch open while a second caller arrives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-gitpull-test'));

const h = vi.hoisted(() => ({
  asyncCalls: [] as string[],
  resolvers: [] as Array<() => void>,
  /** `detached` flag each spawn was given — must be true for group-kill to work. */
  detachedFlags: [] as boolean[],
  /** Precondition probes (git available / is a repo / has a remote). */
  probeCalls: [] as string[],
  /**
   * Canned stdout for the probes, keyed by a substring of the git command.
   * Probes auto-resolve; only the pull itself is held open by a resolver, so
   * `asyncCalls` keeps meaning "the real git work this call did".
   */
  probeAnswers: [
    ['--version', 'git version 2.99.0\n'],
    ['rev-parse --show-prefix', '\n'],
    ['config --get-regexp', ''],
  ] as Array<[string, string]>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');

  // gitAsync now runs git through spawn(detached) so a timeout can kill the whole
  // process GROUP (see execGitGroup) — mock spawn, not exec. Each fake child stays
  // open until its resolver fires, which is what holds a pull "in flight".
  const spawn: any = vi.fn((_file: string, args: readonly string[], opts: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const cmd = args[1] ?? '';

    const child: any = new EventEmitter(); // eslint-disable-line @typescript-eslint/no-explicit-any
    child.pid = 4242;
    const mkStream = (): any => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const s: any = new EventEmitter(); // eslint-disable-line @typescript-eslint/no-explicit-any
      s.setEncoding = () => s;
      return s;
    };
    child.stdout = mkStream();
    child.stderr = mkStream();

    // Preconditions run through the async probes now (they used to be execSync,
    // which is the event-loop block this file exists to keep out) — answer them
    // immediately so only the pull is manually held open.
    const answer = h.probeAnswers.find(([needle]) => cmd.includes(needle))
      ?? (/\bgit remote$/.test(cmd.trim()) ? ['remote', 'origin\n'] as [string, string] : undefined);
    if (answer) {
      h.probeCalls.push(cmd);
      setImmediate(() => {
        child.stdout.emit('data', answer[1]);
        child.emit('close', 0);
      });
      return child;
    }

    // Only the fetch is held open; the local reads around it (branch, refs)
    // answer at once: on a fresh mock repo there is nothing to move.
    if (!/\bfetch\b/.test(cmd)) {
      setImmediate(() => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) child.stdout.emit('data', 'main\n');
        child.emit('close', 0);
      });
      return child;
    }
    h.asyncCalls.push(cmd);
    h.detachedFlags.push(Boolean(opts?.detached));
    h.resolvers.push(() => {
      child.emit('close', 0);
    });
    return child;
  });

  return {
    ...actual,
    spawn,
    // Still mocked: the sync helpers stay in the file for one-shot/CLI callers,
    // and nothing in a test may shell out to the real git.
    execSync: vi.fn((cmd: string) => {
      if (cmd.includes('--version')) return 'git version 2.99.0\n';
      if (cmd.includes('rev-parse --show-prefix')) return '\n';
      if (cmd.includes('config --get-regexp')) throw new Error('no matching config'); // no embedded creds
      if (cmd.trim().endsWith(' remote')) return 'origin\n';
      return '';
    }),
  };
});

import {
  gitPullWalnut, resetSyncProbeCacheForTest, setCompactionInProgress, waitForSyncSettled,
} from '../../src/integrations/git-sync.js';

beforeEach(() => {
  h.asyncCalls.length = 0;
  h.resolvers.length = 0;
  h.detachedFlags.length = 0;
  h.probeCalls.length = 0;
  resetSyncProbeCacheForTest();
});

describe('gitPullWalnut single-flight', () => {
  it('two concurrent calls result in ONE underlying fetch', async () => {
    const p1 = gitPullWalnut();
    const p2 = gitPullWalnut(); // arrives while the first pull is in flight

    await vi.waitFor(() => expect(h.asyncCalls).toHaveLength(1));
    expect(h.asyncCalls[0]).toContain('fetch origin main');

    h.resolvers.shift()!();
    await Promise.all([p1, p2]);

    // Still exactly one fetch: the second caller shared the in-flight promise.
    expect(h.asyncCalls).toHaveLength(1);
  });

  it('a call AFTER the previous pull completed starts a fresh pull', async () => {
    const p1 = gitPullWalnut();
    await vi.waitFor(() => expect(h.asyncCalls).toHaveLength(1));
    h.resolvers.shift()!();
    await p1;

    const p2 = gitPullWalnut();
    await vi.waitFor(() => expect(h.asyncCalls).toHaveLength(2));
    h.resolvers.shift()!();
    await p2;

    expect(h.asyncCalls).toHaveLength(2);
    expect(h.asyncCalls[1]).toContain('fetch origin main');
  });

  it('does not block the event loop while the pull is in flight', async () => {
    const p = gitPullWalnut();
    // If the pull were still execSync, this timer could not fire before resolution.
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    await vi.waitFor(() => expect(ticked).toBe(true));
    h.resolvers.shift()!();
    await p;
  });

  it('spawns git detached so a timeout can reap the whole process group', async () => {
    // Without `detached`, a timeout kills only the top-level git and orphans
    // git-remote-https / send-pack / pack-objects — the 2026-07-25 starvation.
    const p = gitPullWalnut();
    await vi.waitFor(() => expect(h.detachedFlags).toHaveLength(1));
    expect(h.detachedFlags[0]).toBe(true);
    h.resolvers.shift()!();
    await p;
  });
});

// Compaction, its boot-time crash recovery and git maintenance set the flag and
// then wait here: a pull that passed its check just before must be waited for,
// and one that starts after must not run beside them.
describe('gitPullWalnut and the compaction flag', () => {
  it('waitForSyncSettled waits for a pull already in flight', async () => {
    const p = gitPullWalnut();
    await vi.waitFor(() => expect(h.asyncCalls).toHaveLength(1));

    let settled = false;
    const w = waitForSyncSettled().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    const settledWhilePulling = settled;

    // Let the pull finish before asserting, so a failure here can't leave it
    // in flight for the next test.
    h.resolvers.shift()!();
    await Promise.all([p, w]);
    expect(settledWhilePulling).toBe(false);
    expect(settled).toBe(true);
  });

  it('a pull started while the compaction flag is held stands aside', async () => {
    setCompactionInProgress(true);
    try {
      const p = gitPullWalnut();
      await new Promise((r) => setTimeout(r, 50));
      h.resolvers.splice(0).forEach((resolve) => resolve()); // never leave a pull hanging
      await p;
    } finally {
      setCompactionInProgress(false);
    }
    expect(h.asyncCalls).toHaveLength(0);
  });
});
