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
});
