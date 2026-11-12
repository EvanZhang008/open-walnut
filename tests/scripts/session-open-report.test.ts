import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

describe('measured chat opens report', () => {
  it('separates native cached and cold opens, retains timeouts and never invents an absent group', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-open-report-'));
    try {
      const file = path.join(dir, 'opens.log');
      const row = (ms: number, cache: string, client = 'mac-app', outcome = 'content') => JSON.stringify({
        subsystem: 'browser', message: `[session-open] first content neutral-session open ${ms}`,
        args: JSON.stringify({ sessionId: 'neutral-session', ms, cache, client, outcome, entry: 'home-column' }),
      });
      await fs.writeFile(file, [row(100, 'cached'), row(300, 'cached'), row(900, 'cold'), row(30_000, 'cold', 'mac-app', 'timeout'), row(15, 'cold', 'browser'), '{broken'].join('\n'));
      const { stdout } = await exec(process.execPath, ['scripts/session-open-report.mjs', '--mac-app', file]);
      const result = JSON.parse(stdout);
      expect(result.groups).toEqual({
        'mac-app:cached:home-column': { n: 2, p50: 300, worst: 300, atLeast30s: 0 },
        'mac-app:cold:home-column': { n: 1, p50: 900, worst: 900, atLeast30s: 1 },
      });
      await fs.writeFile(file, '');
      const empty = JSON.parse((await exec(process.execPath, ['scripts/session-open-report.mjs', '--mac-app', file])).stdout);
      expect(empty.groups).toEqual({});
      expect(empty.note).toContain('nothing is verified');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps measurement versions and offscreen restores separate without inventing visible timeouts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-open-report-'));
    try {
      const file = path.join(dir, 'opens.log');
      const row = (data: Record<string, unknown>) => JSON.stringify({ subsystem: 'browser',
        message: '[session-open] first content neutral-session open 1', args: JSON.stringify({
          sessionId: 'neutral-session', ms: 30_000, cache: 'cached', client: 'mac-app', entry: 'mount', ...data,
        }) });
      await fs.writeFile(file, [row({ outcome: 'timeout' }), row({ outcome: 'not-visible', measurementVersion: 2,
        outsideViewportAtAttach: true }), row({ outcome: 'content', ms: 5016, measurementVersion: 2,
        outsideViewportAtAttach: true })].join('\n'));
      const result = JSON.parse((await exec(process.execPath, ['scripts/session-open-report.mjs', file])).stdout);
      expect(result.groups).toEqual({
        'mac-app:cached:mount': { n: 0, p50: null, worst: null, atLeast30s: 1 },
        'mac-app:cached:mount:v2:offscreen:not-visible': { n: 0, p50: null, worst: null, atLeast30s: 0 },
        'mac-app:cached:mount:v2:offscreen': { n: 1, p50: 5016, worst: 5016, atLeast30s: 0 },
      });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
