/**
 * Where does a repair session get Walnut's own source? (src/core/self-repair/walnut-source.ts)
 *
 * This file covers the NON-running installs: no WALNUT_INSTALL_DIR, so the
 * answer comes from the configured dir (env / config.yaml), the default clone
 * dir, or a fresh clone. The two other shapes live in siblings because
 * constants are mocked per file: walnut-source-running.test.ts (the checkout
 * the server runs from) and walnut-source-cloud.test.ts (CLOUD_MODE).
 *
 * Safety: `node:child_process`.execFile is stubbed for the whole file, so no
 * test can ever run a real `git clone`, and WALNUT_SELF_REPAIR_CLONE_DIR always
 * points inside this file's own tmp tree — never the real ~/open-walnut.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

const { execFileMock, getConfigMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  getConfigMock: vi.fn(),
}));

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-selfrepair'));

// Partial mock: only execFile is replaced, so anything else in the graph that
// needs child_process (spawn, …) keeps working.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock, default: { ...actual, execFile: execFileMock } };
});

vi.mock('../../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/config-manager.js')>();
  return { ...actual, getConfig: getConfigMock };
});

import { WALNUT_REPO_URL } from '../../../src/constants.js';
import {
  isWalnutCheckout,
  defaultCloneDir,
  resolveWalnutSource,
  hasGit,
  getSelfRepairStatus,
  explainUnavailable,
  ensureWalnutSource,
  WalnutSourceError,
  _resetSelfRepairForTesting,
  type SelfRepairStatus,
} from '../../../src/core/self-repair/walnut-source.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-selfrepair-'));
let seq = 0;

/** A fresh path inside this file's tmp tree. Nothing is created on disk. */
function tmpPath(name: string): string {
  return path.join(TMP_ROOT, `${name}-${++seq}`);
}

/** package.json naming open-walnut + a .git (dir by default, file = worktree). */
function makeCheckout(dir: string, opts: { name?: string; git?: 'dir' | 'file' | 'none' } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: opts.name ?? 'open-walnut' }));
  const git = opts.git ?? 'dir';
  if (git === 'dir') fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (git === 'file') fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
  return dir;
}

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

/** Answers only the `git --version` probe; any other git call is a test bug. */
function gitProbeOnly(cmd: string, args: string[], _opts: unknown, cb: ExecCb): unknown {
  if (args[0] === '--version') {
    cb(null, 'git version 2.39.0\n', '');
    return {};
  }
  cb(new Error(`unexpected execFile: ${cmd} ${args.join(' ')}`), '', 'unexpected');
  return {};
}

beforeEach(() => {
  delete process.env.WALNUT_SOURCE_DIR;
  // Default: a clone dir path that does NOT exist (so "nothing here yet").
  process.env.WALNUT_SELF_REPAIR_CLONE_DIR = tmpPath('clone-dir');
  _resetSelfRepairForTesting();
  execFileMock.mockReset();
  execFileMock.mockImplementation(gitProbeOnly);
  getConfigMock.mockReset();
  getConfigMock.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.WALNUT_SOURCE_DIR;
  delete process.env.WALNUT_SELF_REPAIR_CLONE_DIR;
  _resetSelfRepairForTesting();
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('isWalnutCheckout', () => {
  it('accepts open-walnut + a .git directory', () => {
    expect(isWalnutCheckout(makeCheckout(tmpPath('ok')))).toBe(true);
  });

  it('accepts a worktree, where .git is a FILE', () => {
    expect(isWalnutCheckout(makeCheckout(tmpPath('worktree'), { git: 'file' }))).toBe(true);
  });

  it('rejects another package that happens to be a git repo', () => {
    expect(isWalnutCheckout(makeCheckout(tmpPath('acme'), { name: 'acme' }))).toBe(false);
  });

  it('rejects a source tree with no .git (a tarball, an npm install)', () => {
    expect(isWalnutCheckout(makeCheckout(tmpPath('nogit'), { git: 'none' }))).toBe(false);
  });

  it('rejects a missing dir and an unparseable package.json', () => {
    expect(isWalnutCheckout(tmpPath('absent'))).toBe(false);
    const broken = tmpPath('broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'package.json'), '{ not json');
    fs.mkdirSync(path.join(broken, '.git'));
    expect(isWalnutCheckout(broken)).toBe(false);
  });
});

describe('defaultCloneDir', () => {
  it('honours WALNUT_SELF_REPAIR_CLONE_DIR', () => {
    const dir = tmpPath('explicit');
    process.env.WALNUT_SELF_REPAIR_CLONE_DIR = dir;
    expect(defaultCloneDir()).toBe(dir);
  });

  it('expands a leading ~ in the override', () => {
    process.env.WALNUT_SELF_REPAIR_CLONE_DIR = '~/acme-clone';
    expect(defaultCloneDir()).toBe(path.join(os.homedir(), 'acme-clone'));
  });

  it('defaults to ~/open-walnut, outside the synced data dir', () => {
    delete process.env.WALNUT_SELF_REPAIR_CLONE_DIR;
    expect(defaultCloneDir()).toBe(path.join(os.homedir(), 'open-walnut'));
  });
});

describe('resolveWalnutSource', () => {
  it('takes WALNUT_SOURCE_DIR when it is a real checkout', async () => {
    const dir = makeCheckout(tmpPath('configured'));
    process.env.WALNUT_SOURCE_DIR = dir;
    expect(await resolveWalnutSource()).toEqual({ dir, kind: 'configured' });
  });

  it('takes self_repair.source_dir from config when no env is set', async () => {
    const dir = makeCheckout(tmpPath('from-config'));
    getConfigMock.mockResolvedValue({ self_repair: { source_dir: dir } });
    expect(await resolveWalnutSource()).toEqual({ dir, kind: 'configured' });
  });

  it('prefers the env over config', async () => {
    const fromEnv = makeCheckout(tmpPath('env-wins'));
    const fromConfig = makeCheckout(tmpPath('config-loses'));
    process.env.WALNUT_SOURCE_DIR = fromEnv;
    getConfigMock.mockResolvedValue({ self_repair: { source_dir: fromConfig } });
    expect(await resolveWalnutSource()).toEqual({ dir: fromEnv, kind: 'configured' });
  });

  it('ignores a configured dir that is not a checkout and falls through to the clone dir', async () => {
    process.env.WALNUT_SOURCE_DIR = makeCheckout(tmpPath('not-walnut'), { name: 'acme' });
    const cloneDir = makeCheckout(tmpPath('clone-present'));
    process.env.WALNUT_SELF_REPAIR_CLONE_DIR = cloneDir;
    expect(await resolveWalnutSource()).toEqual({ dir: cloneDir, kind: 'clone' });
  });

  it('is null when the configured dir is bogus and no clone exists yet', async () => {
    process.env.WALNUT_SOURCE_DIR = tmpPath('missing-entirely');
    expect(await resolveWalnutSource()).toBeNull();
  });

  it('survives a config read that throws', async () => {
    getConfigMock.mockRejectedValue(new Error('config.yaml is unreadable'));
    expect(await resolveWalnutSource()).toBeNull();
  });
});

describe('hasGit', () => {
  it('probes once per process, and re-probes a failure only after the memo expires', async () => {
    expect(await hasGit()).toBe(true);
    expect(await hasGit()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    _resetSelfRepairForTesting();
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
      cb(new Error('spawn git ENOENT'), '', '');
      return {};
    });
    expect(await hasGit()).toBe(false);
    // A failed probe is held for a while (every /api/config asks), not forever:
    // git can be installed while Walnut runs, so the memo expires on a timer.
    expect(await hasGit()).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    _resetSelfRepairForTesting();
    expect(await hasGit()).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });
});

describe('getSelfRepairStatus', () => {
  it('is available with the resolved source, and always echoes cloneDir + repoUrl', async () => {
    const dir = makeCheckout(tmpPath('status-configured'));
    process.env.WALNUT_SOURCE_DIR = dir;
    const status = await getSelfRepairStatus();
    expect(status).toEqual({
      available: true,
      source: { dir, kind: 'configured' },
      cloneDir: process.env.WALNUT_SELF_REPAIR_CLONE_DIR,
      repoUrl: WALNUT_REPO_URL,
    });
  });

  it('is available with a null source when nothing exists but git can clone one', async () => {
    const status = await getSelfRepairStatus();
    expect(status.available).toBe(true);
    expect(status.source).toBeNull();
    expect(status.reason).toBeUndefined();
  });

  it('refuses to clone over something else already living at the clone path', async () => {
    const occupied = makeCheckout(tmpPath('occupied'), { name: 'acme' });
    process.env.WALNUT_SELF_REPAIR_CLONE_DIR = occupied;
    const status = await getSelfRepairStatus();
    expect(status.available).toBe(false);
    expect(status.source).toBeNull();
    expect(status.reason).toBe('clone-dir-occupied');
  });

  it('reports no-git when the probe fails and there is nothing to clone into', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
      cb(new Error('spawn git ENOENT'), '', '');
      return {};
    });
    const status = await getSelfRepairStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toBe('no-git');
  });
});

describe('explainUnavailable', () => {
  const base: SelfRepairStatus = {
    available: false,
    source: null,
    cloneDir: '/tmp/acme/open-walnut',
    repoUrl: 'https://example.invalid/open-walnut.git',
  };

  it('points a cloud replica at the primary console', () => {
    expect(explainUnavailable({ ...base, reason: 'cloud' })).toContain('primary console');
  });

  it('names both ways out when git is missing', () => {
    const text = explainUnavailable({ ...base, reason: 'no-git' });
    expect(text).toContain('git is not installed');
    expect(text).toContain(base.repoUrl);
    expect(text).toContain('self_repair.source_dir');
  });

  it('names the occupied path so the user can move it aside', () => {
    const text = explainUnavailable({ ...base, reason: 'clone-dir-occupied' });
    expect(text).toContain(base.cloneDir);
    expect(text).toContain('WALNUT_SOURCE_DIR');
  });

  it('has a generic fallback for an unlabelled status', () => {
    expect(explainUnavailable(base)).toBe('No Walnut source is available for a repair session.');
  });
});

describe('ensureWalnutSource', () => {
  /** execFile stub that answers the probe and "clones" by creating the staging tree. */
  function cloneSucceeds(opts: { alsoCreateTarget?: string } = {}) {
    return (cmd: string, args: string[], _o: unknown, cb: ExecCb): unknown => {
      if (args[0] === '--version') {
        cb(null, 'git version 2.39.0\n', '');
        return {};
      }
      if (args[0] === 'clone') {
        makeCheckout(args[3]);
        if (opts.alsoCreateTarget) makeCheckout(opts.alsoCreateTarget);
        cb(null, '', '');
        return {};
      }
      cb(new Error(`unexpected execFile: ${cmd} ${args.join(' ')}`), '', '');
      return {};
    };
  }

  it('uses an existing source without touching git at all', async () => {
    const dir = makeCheckout(tmpPath('already-there'));
    process.env.WALNUT_SOURCE_DIR = dir;
    const result = await ensureWalnutSource();
    expect(result).toEqual({ source: { dir, kind: 'configured' }, cloned: false });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('clones upstream into a staging sibling, then renames it into place', async () => {
    const cloneDir = process.env.WALNUT_SELF_REPAIR_CLONE_DIR!;
    const staging = `${cloneDir}.cloning-${process.pid}`;
    execFileMock.mockImplementation(cloneSucceeds());

    const result = await ensureWalnutSource();

    expect(result.cloned).toBe(true);
    expect(result.source).toEqual({ dir: cloneDir, kind: 'clone' });
    const cloneCall = execFileMock.mock.calls.find(c => (c[1] as string[])[0] === 'clone');
    expect(cloneCall![0]).toBe('git');
    expect(cloneCall![1]).toEqual(['clone', '--quiet', WALNUT_REPO_URL, staging]);
    // No credential prompt can be answered from a server process.
    expect((cloneCall![2] as { env: Record<string, string> }).env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(fs.existsSync(staging)).toBe(false);
    expect(isWalnutCheckout(cloneDir)).toBe(true);
  });

  it('keeps a checkout the user cloned by hand while ours was running', async () => {
    const cloneDir = process.env.WALNUT_SELF_REPAIR_CLONE_DIR!;
    const staging = `${cloneDir}.cloning-${process.pid}`;
    execFileMock.mockImplementation(cloneSucceeds({ alsoCreateTarget: cloneDir }));

    const result = await ensureWalnutSource();

    expect(result.source.dir).toBe(cloneDir);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('shares one clone between concurrent callers', async () => {
    execFileMock.mockImplementation(cloneSucceeds());
    // Warm the memoized git probe + the config read so both callers reach the
    // in-flight guard within the same tick.
    expect((await getSelfRepairStatus()).available).toBe(true);
    execFileMock.mockClear();

    const [a, b] = await Promise.all([ensureWalnutSource(), ensureWalnutSource()]);

    expect(a.source.dir).toBe(b.source.dir);
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[0] === 'clone')).toHaveLength(1);
  });

  it('fails with a 502 + the manual command, and leaves no half-checkout behind', async () => {
    const cloneDir = process.env.WALNUT_SELF_REPAIR_CLONE_DIR!;
    const staging = `${cloneDir}.cloning-${process.pid}`;
    execFileMock.mockImplementation((_cmd: string, args: string[], _o: unknown, cb: ExecCb) => {
      if (args[0] === '--version') {
        cb(null, 'git version 2.39.0\n', '');
        return {};
      }
      // A real failure writes the staging dir before dying.
      fs.mkdirSync(args[3], { recursive: true });
      cb(new Error('Command failed: git clone'), '', 'fatal: could not read from remote repository\n');
      return {};
    });

    const err = await ensureWalnutSource().catch(e => e);
    expect(err).toBeInstanceOf(WalnutSourceError);
    expect((err as WalnutSourceError).statusCode).toBe(502);
    expect((err as Error).message).toContain('fatal: could not read');
    expect((err as Error).message).toContain(`git clone ${WALNUT_REPO_URL} ${cloneDir}`);
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(cloneDir)).toBe(false);
  });

  it('propagates the unavailable reason as a 503 instead of trying anyway', async () => {
    process.env.WALNUT_SELF_REPAIR_CLONE_DIR = makeCheckout(tmpPath('occupied-ensure'), { name: 'acme' });
    const err = await ensureWalnutSource().catch(e => e);
    expect(err).toBeInstanceOf(WalnutSourceError);
    expect((err as WalnutSourceError).statusCode).toBe(503);
    expect(execFileMock.mock.calls.filter(c => (c[1] as string[])[0] === 'clone')).toHaveLength(0);
  });
});
