/**
 * Regression tests for the 2026-07-25 machine-starvation incident.
 *
 * Two independent defects let a slow git push take down the whole box
 * (load average 211, swap exhausted, every HTTP request timing out at 15s):
 *
 *  1. execAsync's `timeout` signals only the top-level `git`, not the process
 *     TREE (`git push` → `git-remote-https` → `send-pack` → `pack-objects`).
 *     Timed-out children reparented to pid 1 and kept burning CPU/RAM —
 *     `pack-objects` alone held ~1.9GB. Four such trees were found alive.
 *  2. sync() had no latch. The tick relied on setTimeout self-rescheduling for
 *     serialization, but a timed-out tick RESOLVES, so it armed the next tick
 *     while the orphan kept packing. Every 60s stacked another layer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { gitAsync, sync } from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';

let binDir: string;
let pidFile: string;
let originalPath: string | undefined;

/** Is a pid alive? kill(pid, 0) throws ESRCH when it isn't. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });

  // A fake `git` that spawns a long-lived GRANDCHILD and writes both pids out,
  // mimicking git's real process tree. The parent waits forever too.
  binDir = path.join(WALNUT_HOME, 'fakebin');
  await fsp.mkdir(binDir, { recursive: true });
  pidFile = path.join(binDir, 'pids.txt');
  await fsp.writeFile(
    path.join(binDir, 'git'),
    `#!/bin/bash
# Grandchild — stands in for pack-objects: the process that actually leaked.
sleep 600 &
grandchild=$!
echo "$$ $grandchild" > ${JSON.stringify(pidFile)}
wait $grandchild
`,
    { mode: 0o755 },
  );

  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('gitAsync timeout reaping', () => {
  it('kills the ENTIRE process group, leaving no orphaned grandchild', async () => {
    await expect(gitAsync('status --porcelain', { timeout: 500 })).rejects.toThrow(/timed out/i);

    // The fake git wrote "<parent> <grandchild>" before hanging.
    const [parentPid, grandchildPid] = fs
      .readFileSync(pidFile, 'utf-8')
      .trim()
      .split(/\s+/)
      .map(Number);
    expect(Number.isFinite(parentPid)).toBe(true);
    expect(Number.isFinite(grandchildPid)).toBe(true);

    // SIGTERM → SIGKILL escalation needs a moment (KILL_GRACE_MS = 3s).
    const bothDead = await waitUntil(
      () => !isAlive(parentPid) && !isAlive(grandchildPid),
      8_000,
    );

    // The old execAsync path killed only the parent — this is the assertion
    // that fails if the process-group kill regresses.
    expect(isAlive(grandchildPid)).toBe(false);
    expect(bothDead).toBe(true);
  }, 20_000);

  it('reports the timeout as an error instead of resolving silently', async () => {
    await expect(gitAsync('status --porcelain', { timeout: 300 })).rejects.toThrow(
      /process group killed/i,
    );
  }, 15_000);
});

describe('sync() single-flight latch', () => {
  it('joins an in-flight sync instead of starting a second git chain', async () => {
    // Real git needed here — sync() runs add/commit against WALNUT_HOME.
    process.env.PATH = originalPath ?? '';
    execSync('git init -q', { cwd: WALNUT_HOME });
    execSync('git config user.email t@t.t && git config user.name t', {
      cwd: WALNUT_HOME,
      shell: '/bin/bash',
    });
    await fsp.writeFile(path.join(WALNUT_HOME, 'a.txt'), 'hello');

    // Two concurrent callers (the 30s tick and the CLI `sync` command) must
    // share ONE run — that's what makes stacking structurally impossible.
    const [first, second] = await Promise.all([sync(), sync()]);
    expect(second).toBe(first);
  }, 30_000);
});
