/**
 * The install that repairs itself: the server runs FROM a git checkout, so
 * WALNUT_INSTALL_DIR is the source and wins over everything else.
 *
 * Separate file from walnut-source.test.ts because constants are mocked once
 * per file, and this shape needs WALNUT_INSTALL_DIR set for every case.
 * execFile is stubbed so a bug here can never reach a real `git clone`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

// Literal, not a const: vi.mock factories are hoisted above module-level consts.
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-selfrepair-running', {
  WALNUT_INSTALL_DIR: '/fake/walnut-checkout',
  WALNUT_PACKAGE_ROOT: '/fake/walnut-checkout',
}));

const RUNNING_DIR = '/fake/walnut-checkout';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock, default: { ...actual, execFile: execFileMock } };
});

import {
  resolveWalnutSource,
  getSelfRepairStatus,
  ensureWalnutSource,
  _resetSelfRepairForTesting,
} from '../../../src/core/self-repair/walnut-source.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-selfrepair-running-'));
let seq = 0;

function makeCheckout(name: string): string {
  const dir = path.join(TMP_ROOT, `${name}-${++seq}`);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'open-walnut' }));
  return dir;
}

beforeEach(() => {
  process.env.WALNUT_SELF_REPAIR_CLONE_DIR = path.join(TMP_ROOT, `clone-${++seq}`);
  _resetSelfRepairForTesting();
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd: string, _args: string[], _o: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
    cb(null, 'git version 2.39.0\n', '');
    return {};
  });
});

afterEach(() => {
  delete process.env.WALNUT_SOURCE_DIR;
  delete process.env.WALNUT_SELF_REPAIR_CLONE_DIR;
  _resetSelfRepairForTesting();
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('resolveWalnutSource with WALNUT_INSTALL_DIR', () => {
  it('is the running checkout', async () => {
    expect(await resolveWalnutSource()).toEqual({ dir: RUNNING_DIR, kind: 'running' });
  });

  it('wins over a configured dir and an existing clone', async () => {
    process.env.WALNUT_SOURCE_DIR = makeCheckout('configured');
    process.env.WALNUT_SELF_REPAIR_CLONE_DIR = makeCheckout('clone-present');
    expect(await resolveWalnutSource()).toEqual({ dir: RUNNING_DIR, kind: 'running' });
  });
});

describe('getSelfRepairStatus / ensureWalnutSource with WALNUT_INSTALL_DIR', () => {
  it('is available in the running checkout', async () => {
    const status = await getSelfRepairStatus();
    expect(status.available).toBe(true);
    expect(status.source).toEqual({ dir: RUNNING_DIR, kind: 'running' });
    expect(status.reason).toBeUndefined();
  });

  it('never probes git and never clones', async () => {
    const result = await ensureWalnutSource();
    expect(result).toEqual({ source: { dir: RUNNING_DIR, kind: 'running' }, cloned: false });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
