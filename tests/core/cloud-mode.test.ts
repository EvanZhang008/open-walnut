/**
 * CLOUD_MODE tests — the headless cloud-companion deployment flag.
 *
 * Covers:
 *  1. The CLOUD_MODE constant reflects the WALNUT_CLOUD_MODE env var
 *     (read at import time → vi.resetModules + dynamic import per case).
 *  2. The cron allowlist guard: only git-sync/backup infra jobs may run on
 *     the cloud box; business crons are skipped (they'd double-run with the
 *     primary box since cron-jobs.json syncs via git).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cloudModeSkipsJob } from '../../src/core/cron/jobs.js';
import type { CronJob } from '../../src/core/cron/types.js';

// ── Helpers ──

function makeJob(overrides: Partial<CronJob> & { name: string }): CronJob {
  return {
    id: 'job-test',
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: 'every', everyMs: 60_000, anchorMs: 0 },
    sessionTarget: 'main',
    wakeMode: 'next-cycle',
    payload: { kind: 'systemEvent', text: 'tick' },
    state: {},
    ...overrides,
  };
}

// ── 1. CLOUD_MODE constant reflects env ──

describe('CLOUD_MODE constant', () => {
  const ORIGINAL = process.env.WALNUT_CLOUD_MODE;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WALNUT_CLOUD_MODE;
    else process.env.WALNUT_CLOUD_MODE = ORIGINAL;
    vi.resetModules();
  });

  it('is false when WALNUT_CLOUD_MODE is unset', async () => {
    delete process.env.WALNUT_CLOUD_MODE;
    const { CLOUD_MODE } = await import('../../src/constants.js');
    expect(CLOUD_MODE).toBe(false);
  });

  it('is true when WALNUT_CLOUD_MODE=1', async () => {
    process.env.WALNUT_CLOUD_MODE = '1';
    const { CLOUD_MODE } = await import('../../src/constants.js');
    expect(CLOUD_MODE).toBe(true);
  });

  it('is false for any value other than "1"', async () => {
    process.env.WALNUT_CLOUD_MODE = 'true';
    const { CLOUD_MODE } = await import('../../src/constants.js');
    expect(CLOUD_MODE).toBe(false);
  });
});

// ── 2. Cron allowlist guard ──

describe('cloudModeSkipsJob (cron CLOUD_MODE allowlist)', () => {
  it('never skips anything when not in cloud mode', () => {
    const business = makeJob({ name: 'Daily summary' });
    expect(cloudModeSkipsJob(business, false)).toBe(false);
  });

  it('allows git-sync jobs in cloud mode (by name)', () => {
    expect(cloudModeSkipsJob(makeJob({ name: 'git-sync push' }), true)).toBe(false);
    expect(cloudModeSkipsJob(makeJob({ name: 'Git Sync' }), true)).toBe(false);
    expect(cloudModeSkipsJob(makeJob({ name: 'nightly gitsync' }), true)).toBe(false);
  });

  it('allows backup jobs in cloud mode (by name)', () => {
    expect(cloudModeSkipsJob(makeJob({ name: 'Nightly backup' }), true)).toBe(false);
    expect(cloudModeSkipsJob(makeJob({ name: 'Backup notes to S3' }), true)).toBe(false);
  });

  it('allows infra jobs matched via initProcessor actionId', () => {
    const job = makeJob({
      name: 'Data protection',
      initProcessor: { actionId: 'git-sync' },
    });
    expect(cloudModeSkipsJob(job, true)).toBe(false);
  });

  it('skips business crons in cloud mode', () => {
    expect(cloudModeSkipsJob(makeJob({ name: 'Daily summary' }), true)).toBe(true);
    expect(cloudModeSkipsJob(makeJob({ name: 'Next step reminder' }), true)).toBe(true);
    expect(cloudModeSkipsJob(makeJob({ name: 'Life Tracker - Screenshot' }), true)).toBe(true);
  });

  it('skips business agent jobs even with isolated target', () => {
    const job = makeJob({
      name: 'Weekly report',
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn', message: 'write the report' },
    });
    expect(cloudModeSkipsJob(job, true)).toBe(true);
  });
});
