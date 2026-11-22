/**
 * The server's boot check of the data repo (ensureRepo) runs every git call
 * asynchronously. 2026-11-22: done with execSync it held a fresh server's event
 * loop for up to 1.3 s (a boot's stall profile: spawnSync 54%, all of it
 * ensureRepo's git init, identity and probes). Real git, temp dirs only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const sync = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const counted = <F extends (...args: never[]) => unknown>(name: string, fn: F): F =>
    ((...args: Parameters<F>) => { sync.calls.push(`${name} ${String(args[0])}`); return fn(...args); }) as F;
  return {
    ...real,
    default: real,
    execSync: counted('execSync', real.execSync),
    execFileSync: counted('execFileSync', real.execFileSync),
    spawnSync: counted('spawnSync', real.spawnSync),
  };
});

const dirs = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('node:os') as typeof import('node:os');
  const root = p.join(o.tmpdir(), `walnut-boot-async-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return { root, home: p.join(root, '.open-walnut') };
});

vi.mock('../../src/constants.js', async () => {
  const { createMockConstants } = await import('../helpers/mock-constants.js');
  return createMockConstants('walnut-boot-async', { WALNUT_HOME: dirs.home });
});

import { ensureRepo, isGitAvailable } from '../../src/integrations/git-sync.js';

beforeEach(() => {
  fs.rmSync(dirs.root, { recursive: true, force: true });
  fs.mkdirSync(dirs.home, { recursive: true });
  sync.calls.length = 0;
});

afterEach(() => {
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

describe('ensureRepo at boot', () => {
  it('the counter sees a sync git call of git-sync (so an empty count means none ran)', () => {
    expect(isGitAvailable()).toBe(true);
    expect(sync.calls).toEqual(['execSync git --version']);
  });

  it('makes a new data home a repo with no synchronous child process', async () => {
    expect(await ensureRepo()).toEqual({ available: true });
    expect(sync.calls).toEqual([]);
    expect(fs.existsSync(path.join(dirs.home, '.git'))).toBe(true);
    expect(fs.readFileSync(path.join(dirs.home, '.gitignore'), 'utf8')).toContain('auth.json');
  });

  it('adopts an existing data repo with no synchronous child process', async () => {
    expect(await ensureRepo()).toEqual({ available: true });
    sync.calls.length = 0;
    // A second boot: the repo is there, its identity and ignores are healed again.
    expect(await ensureRepo()).toEqual({ available: true });
    expect(sync.calls).toEqual([]);
  });
});
