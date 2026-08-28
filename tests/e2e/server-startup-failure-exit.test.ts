import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';

let child: ChildProcess | null = null;
let blocker: Server | null = null;
let testHome: string | null = null;

async function closeBlocker(): Promise<void> {
  if (!blocker) return;
  const current = blocker;
  blocker = null;
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

afterEach(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child?.once('exit', resolve));
  }
  child = null;
  await closeBlocker();
  if (testHome) await fsp.rm(testHome, { recursive: true, force: true });
  testHome = null;
});

describe('server startup failure lifecycle', () => {
  it('exits promptly and releases its data-directory lock after listen fails', async () => {
    testHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-startup-failure-'));
    blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker!.once('error', reject);
      blocker!.listen(0, resolve);
    });
    const address = blocker.address();
    expect(address && typeof address === 'object').toBe(true);
    const port = typeof address === 'object' && address ? address.port : 0;

    const startedAt = Date.now();
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'web', '--port', String(port), '--dev'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: testHome,
          OPEN_WALNUT_HOME: testHome,
          WALNUT_CLOUD_MODE: '1',
          WALNUT_DISABLE_SEARCH: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('failed startup process did not exit within 15s'));
      }, 15_000);
      child!.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(stderr).toContain('EADDRINUSE');
    expect(fs.existsSync(path.join(testHome, 'server.lock.json'))).toBe(false);
  }, 25_000);
});
