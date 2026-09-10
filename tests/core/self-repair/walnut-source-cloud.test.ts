/**
 * A cloud replica never edits code: repairs start on the primary console.
 *
 * Own file because CLOUD_MODE is a mocked constant, and it has to be true for
 * the whole module graph. execFile is stubbed so nothing can clone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-selfrepair-cloud', {
  CLOUD_MODE: true,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock, default: { ...actual, execFile: execFileMock } };
});

import {
  getSelfRepairStatus,
  ensureWalnutSource,
  explainUnavailable,
  WalnutSourceError,
  _resetSelfRepairForTesting,
} from '../../../src/core/self-repair/walnut-source.js';

beforeEach(() => {
  // A path that does not exist, well away from the real ~/open-walnut.
  process.env.WALNUT_SELF_REPAIR_CLONE_DIR = path.join(os.tmpdir(), `walnut-cloud-never-${process.pid}`);
  _resetSelfRepairForTesting();
  execFileMock.mockReset();
});

afterEach(() => {
  delete process.env.WALNUT_SELF_REPAIR_CLONE_DIR;
  _resetSelfRepairForTesting();
});

describe('self-repair in CLOUD_MODE', () => {
  it('is unavailable for the "cloud" reason, before any git probe', async () => {
    const status = await getSelfRepairStatus();
    expect(status.available).toBe(false);
    expect(status.source).toBeNull();
    expect(status.reason).toBe('cloud');
    expect(execFileMock).not.toHaveBeenCalled();
    expect(explainUnavailable(status)).toContain('primary console');
  });

  it('refuses ensureWalnutSource with a 409, not a 503', async () => {
    const err = await ensureWalnutSource().catch(e => e);
    expect(err).toBeInstanceOf(WalnutSourceError);
    expect((err as WalnutSourceError).statusCode).toBe(409);
    expect((err as Error).message).toContain('primary console');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
