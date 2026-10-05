/**
 * The 'git:repo-size' condition has a lifecycle of its own.
 *
 * The repo-size card used to share the `git` key with the auto-commit card,
 * whose recovery edge is "commits failing, then healthy". That edge never
 * measured size: a repo that shrank (a gc, an aged backup branch) kept its card,
 * and a commit hiccup retired the card while the repo was still too large
 * (2026-10-05, raised by the cloud companion and synced to the Mac). The size
 * sentinel's own pass under the threshold is the recovery signal (a card from
 * before the split hears it through its dedup scope: store.test.ts).
 *
 * Real server: the git tick runs the sentinel on its first pass after boot, so
 * each half waits one poll interval.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Server } from 'node:http';
import { WALNUT_HOME } from '../../src/constants.js';

const GB = 1024 * 1024 * 1024;
const FAKE_PACK = path.join(WALNUT_HOME, '.git', 'objects', 'pack', 'pack-fake-oversize.pack');

let server: (Server & { address: () => { port: number } }) | undefined;
let previousDisableSearch: string | undefined;

async function feed() {
  const { listNotifications } = await import('../../src/core/notifications/store.js');
  return (await listNotifications()).feed;
}

async function pollFeed(pred: (f: Awaited<ReturnType<typeof feed>>) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = await feed();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    last = await feed();
  }
  return last;
}

async function boot(): Promise<void> {
  const { resetRepoSizeCheckForTest } = await import('../../src/integrations/git-sync.js');
  // Module state: the sentinel throttles itself to one pass per 6h, and both
  // servers here live in one process.
  resetRepoSizeCheckForTest();
  const { startServer } = await import('../../src/web/server.js');
  server = await startServer({ port: 0, dev: false }) as typeof server;
}

async function shutdown(): Promise<void> {
  const { stopServer } = await import('../../src/web/server.js');
  await stopServer();
  server = undefined;
}

beforeAll(() => {
  previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH;
  process.env.WALNUT_DISABLE_SEARCH = '1';
  fs.mkdirSync(WALNUT_HOME, { recursive: true });
  // The server's ensureRepo() adopts an existing repo; the fake pack has to be
  // in place before the first tick, so the repo is made here.
  execSync('git init -q', { cwd: WALNUT_HOME, stdio: 'ignore' });
  fs.mkdirSync(path.dirname(FAKE_PACK), { recursive: true });
  const fd = fs.openSync(FAKE_PACK, 'w');
  fs.ftruncateSync(fd, 3.5 * GB); // sparse: no disk is used
  fs.closeSync(fd);
}, 30_000);

afterAll(async () => {
  if (server) await shutdown();
  fs.rmSync(FAKE_PACK, { force: true });
  if (previousDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH;
  else process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch;
});

describe('git:repo-size lifecycle', () => {
  it('an oversized data repo raises ONE card under its own key, filed with the data cards', async () => {
    await boot();
    const raised = await pollFeed((f) =>
      f.some((n) => n.recoveryKey === 'git:repo-size' && !n.resolved && n.kind === 'operation-error'), 90_000);
    const cards = raised.filter((n) => n.recoveryKey === 'git:repo-size' && !n.resolved);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Data Repo Growing Too Large');
    expect(cards[0].category).toBe('Data & Sync');
    expect(cards[0].body).toMatch(/3\.5GB of live packs/);
    expect(cards[0].dedupKey).toBe('error:git:repo-size');
    await shutdown();
  }, 150_000);

  it('a boot that measures the repo under the threshold retires the card', async () => {
    fs.rmSync(FAKE_PACK, { force: true });

    await boot();
    const settled = await pollFeed((f) =>
      f.some((n) => n.dedupKey === 'error:git:repo-size' && n.resolved === 'recovered'), 90_000);
    expect(settled.find((n) => n.dedupKey === 'error:git:repo-size')?.resolved).toBe('recovered');
    await shutdown();
  }, 150_000);
});
