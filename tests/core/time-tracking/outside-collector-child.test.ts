/**
 * Outside-activity collector — the CHILD half, against a fake helper.
 *
 * No swiftc and no macOS APIs: a node script is dropped at the exact cached
 * binary path the collector looks for, so the real spawn → parse → bank → stop
 * path runs. The fake reproduces the shape that made the leak possible — a
 * wrapper process with an inner child doing the writing (the real helper re-execs
 * to disclaim TCC responsibility) — because killing only the pid we hold left
 * that inner process sampling forever.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-outside-child'));

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js';
import {
  HELPER_VERSION, isOutsideCollectorRunning, resetOutsideCollectorForTest, startOutsideCollector,
  stopOutsideCollector,
} from '../../../src/core/time-tracking/outside-collector.js';
import { getOutsideIndex, resetOutsideStore } from '../../../src/core/time-tracking/outside-store.js';

/** The cached path the collector looks for — versioned, so a bump can't leave
 *  this test silently spawning nothing. */
const HELPER_BIN = () => path.join(WALNUT_HOME, 'cache', `walnut-activity-${HELPER_VERSION}`);
const PIDS_FILE = () => path.join(WALNUT_HOME, 'fake-helper-pids.json');

/**
 * A stand-in helper: the outer process spawns an inner one that does the writing,
 * then blocks. Both pids are written to disk so the test can prove they died.
 * `WALNUT_FAKE_EXIT_AFTER` makes the inner exit on its own, which is how the
 * restart path is exercised.
 */
function fakeHelperSource(): string {
  return `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const pidsFile = ${JSON.stringify(PIDS_FILE())};
const exitAfter = Number(process.env.WALNUT_FAKE_EXIT_AFTER ?? 0);
if (!process.env.WALNUT_FAKE_INNER) {
  const inner = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, WALNUT_FAKE_INNER: '1' },
  });
  fs.writeFileSync(pidsFile, JSON.stringify({ wrapper: process.pid, inner: inner.pid }));
  // Wait on the inner like the real wrapper's waitpid, and deliberately forward
  // NO signal: the collector's process-group kill has to reach the inner itself.
  inner.on('exit', (code) => process.exit(typeof code === 'number' ? code : 0));
} else {
  let n = 0;
  const tick = () => {
    n += 1;
    const ts = new Date().toISOString().slice(0, 19);
    process.stdout.write(JSON.stringify({
      ts, app: 'Fake Editor', bundleId: 'test.fake.editor', idleSecs: 1, locked: false,
    }) + '\\n');
    if (exitAfter > 0 && n >= exitAfter) process.exit(7);
  };
  tick();
  setInterval(tick, 150);
}
`;
}

async function installFakeHelper(): Promise<void> {
  const bin = HELPER_BIN();
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, fakeHelperSource(), 'utf-8');
  await fs.chmod(bin, 0o755);
}

async function enableInConfig(): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, 'time:\n  outside:\n    enabled: true\n', 'utf-8');
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

async function readPids(): Promise<{ wrapper: number; inner: number }> {
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(await fs.readFile(PIDS_FILE(), 'utf-8')) as { wrapper: number; inner: number };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('fake helper never reported its pids');
}

beforeEach(async () => {
  resetOutsideCollectorForTest();
  resetOutsideStore();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  await installFakeHelper();
  await enableInConfig();
});

afterEach(async () => {
  resetOutsideCollectorForTest();
  resetOutsideStore();
  delete process.env.WALNUT_FAKE_EXIT_AFTER;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

// The collector refuses to start off macOS (the real helper is a Swift binary that
// samples via Apple APIs), so this spawn → bank → stop path only exists there.
describe.skipIf(process.platform !== 'darwin')('collector child lifecycle', () => {
  it('spawns, banks samples, and stop() kills the WHOLE tree', async () => {
    await startOutsideCollector();
    expect(isOutsideCollectorRunning()).toBe(true);

    const { wrapper, inner } = await readPids();
    expect(await waitFor(() => getOutsideIndex().size > 0)).toBe(true);
    expect(alive(wrapper)).toBe(true);
    expect(alive(inner)).toBe(true);

    stopOutsideCollector();
    expect(isOutsideCollectorRunning()).toBe(false);
    // The inner process is the one that leaked: it writes the samples and nothing
    // else would ever stop it.
    expect(await waitFor(() => !alive(wrapper) && !alive(inner), 5000)).toBe(true);

    // Nothing keeps arriving after stop (no listener left attached).
    const size = getOutsideIndex().size;
    await new Promise((r) => setTimeout(r, 400));
    expect(getOutsideIndex().size).toBe(size);
  }, 25_000);

  it('leaves no orphan across an off → on → off cycle', async () => {
    await startOutsideCollector();
    const first = await readPids();
    stopOutsideCollector();
    expect(await waitFor(() => !alive(first.inner), 5000)).toBe(true);

    // Clear the ledger so readPids() cannot return the first run's pids.
    await fs.rm(PIDS_FILE(), { force: true });
    await startOutsideCollector();
    const second = await readPids();
    expect(second.inner).not.toBe(first.inner);
    stopOutsideCollector();
    expect(await waitFor(() => !alive(second.wrapper) && !alive(second.inner), 5000)).toBe(true);
    expect(alive(first.inner)).toBe(false);
  }, 25_000);

  it('restarts after the child dies on its own', async () => {
    // The inner exits after two lines; 'close' (not just 'exit') has to be what
    // clears `child`, or the API reports running:true against a dead process.
    process.env.WALNUT_FAKE_EXIT_AFTER = '2';
    await startOutsideCollector();
    const first = await readPids();
    expect(await waitFor(() => !alive(first.inner), 5000)).toBe(true);
    expect(await waitFor(() => !isOutsideCollectorRunning(), 5000)).toBe(true);

    // Backoff is 5s for the first retry.
    expect(await waitFor(() => isOutsideCollectorRunning(), 12_000)).toBe(true);
    stopOutsideCollector();
  }, 30_000);

  it('does not spawn anything while the config toggle is off', async () => {
    await fs.writeFile(CONFIG_FILE, 'time:\n  outside:\n    enabled: false\n', 'utf-8');
    await startOutsideCollector();
    expect(isOutsideCollectorRunning()).toBe(false);
    await expect(fs.readFile(PIDS_FILE(), 'utf-8')).rejects.toThrow();
  }, 15_000);
});
