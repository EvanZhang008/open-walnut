/**
 * gitPullWalnut single-flight + async conversion.
 *
 * session:result and session:error handlers both call gitPullWalnut() and can
 * fire together — two parallel `git pull` processes would collide on
 * .git/index.lock. Concurrent callers must share ONE in-flight pull.
 *
 * child_process is mocked so we can count the underlying git invocations and
 * hold the pull open while a second caller arrives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-gitpull-test'));

const h = vi.hoisted(() => ({
  asyncCalls: [] as string[],
  resolvers: [] as Array<() => void>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const util = await import('node:util');
  const exec: any = vi.fn(); // eslint-disable-line @typescript-eslint/no-explicit-any
  // gitAsync uses promisify(exec) — provide the custom promisified form so the
  // mocked async git call resolves { stdout, stderr } like the real one.
  exec[util.promisify.custom] = (cmd: string) =>
    new Promise<{ stdout: string; stderr: string }>((resolve) => {
      h.asyncCalls.push(cmd);
      h.resolvers.push(() => resolve({ stdout: 'Already up to date.\n', stderr: '' }));
    });
  return {
    ...actual,
    exec,
    // Sync preflight checks (isGitAvailable / isRepo / hasRemote / credential guard).
    execSync: vi.fn((cmd: string) => {
      if (cmd.includes('--version')) return 'git version 2.99.0\n';
      if (cmd.includes('rev-parse --is-inside-work-tree')) return 'true\n';
      if (cmd.includes('config --get-regexp')) throw new Error('no matching config'); // no embedded creds
      if (cmd.trim().endsWith(' remote')) return 'origin\n';
      return '';
    }),
  };
});

import { gitPullWalnut } from '../../src/integrations/git-sync.js';

beforeEach(() => {
  h.asyncCalls.length = 0;
  h.resolvers.length = 0;
});

describe('gitPullWalnut single-flight', () => {
  it('two concurrent calls result in ONE underlying git pull', async () => {
    const p1 = gitPullWalnut();
    const p2 = gitPullWalnut(); // arrives while the first pull is in flight

    await vi.waitFor(() => expect(h.asyncCalls).toHaveLength(1));
    expect(h.asyncCalls[0]).toContain('pull --ff-only');

    h.resolvers.shift()!();
    await Promise.all([p1, p2]);

    // Still exactly one pull — the second caller shared the in-flight promise.
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
    expect(h.asyncCalls[1]).toContain('pull --ff-only');
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
});
