/**
 * The 'web-assets' condition has a lifecycle.
 *
 * A deploy re-stages dist while the OLD server is still running, so that server's
 * 60s check finds its index.html gone and logs an error. The card that raised was
 * keyless: nothing could ever retire it, and it sat until the 48h debris sweep
 * (2026-10-04, raised by the cloud companion's deploy and synced to the Mac).
 * The NEW server booting with its assets in place is the recovery signal, and so
 * is the running server seeing them come back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';

let tmp: string;
let staticDir: string;
let server: (Server & { address: () => { port: number } }) | undefined;
let previousDisableSearch: string | undefined;

function writeBuild(): void {
  fs.mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'),
    '<!doctype html><script type="module" src="/assets/index-ABC123.js"></script>');
  fs.writeFileSync(path.join(staticDir, 'assets', 'index-ABC123.js'), 'entry\n');
}

async function feed() {
  const { listNotifications } = await import('../../src/core/notifications/store.js');
  return (await listNotifications()).feed;
}

async function pollFeed(pred: (f: Awaited<ReturnType<typeof feed>>) => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = await feed();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    last = await feed();
  }
  return last;
}

async function boot(): Promise<void> {
  const { startServer } = await import('../../src/web/server.js');
  server = await startServer({ port: 0, dev: false }) as typeof server;
}

async function shutdown(): Promise<void> {
  const { stopServer } = await import('../../src/web/server.js');
  await stopServer();
  server = undefined;
}

beforeAll(async () => {
  previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH;
  process.env.WALNUT_DISABLE_SEARCH = '1';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-web-assets-'));
  staticDir = path.join(tmp, 'stage', 'dist', 'web', 'static');
  process.env.WALNUT_WEB_STATIC_DIR = staticDir;
  process.env.WALNUT_WEB_STATIC_MIRROR = path.join(tmp, 'mirror');
}, 30_000);

afterAll(async () => {
  if (server) await shutdown();
  delete process.env.WALNUT_WEB_STATIC_MIRROR;
  delete process.env.WALNUT_WEB_STATIC_DIR;
  if (previousDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH;
  else process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('web-assets lifecycle', () => {
  it('a boot with its assets in place retires the previous life\'s VANISHED card', async () => {
    // The card the old server raised when the deploy swept its dist.
    const { upsertNotification } = await import('../../src/core/notifications/store.js');
    const { record } = await upsertNotification({
      kind: 'operation-error', severity: 'error',
      title: 'Web assets VANISHED from under the running server',
      dedupKey: 'logerr:web:test-vanished', recoveryKey: 'web-assets',
    });
    expect(record.resolved).toBeUndefined();

    writeBuild();
    await boot();
    const settled = await pollFeed((f) =>
      f.some((n) => n.dedupKey === 'logerr:web:test-vanished' && n.resolved === 'recovered'));
    expect(settled.find((n) => n.dedupKey === 'logerr:web:test-vanished')?.resolved).toBe('recovered');
    await shutdown();
  }, 120_000);

  it('a boot WITHOUT servable assets raises a card under the same key, so the next good boot settles it', async () => {
    fs.rmSync(path.join(staticDir, 'index.html'), { force: true });
    await boot();
    const raised = await pollFeed((f) =>
      f.some((n) => n.recoveryKey === 'web-assets' && !n.resolved && n.kind === 'operation-error'));
    const card = raised.find((n) => n.recoveryKey === 'web-assets' && !n.resolved);
    expect(card).toBeDefined();
    expect(card!.category).toBe('Server');
    await shutdown();
  }, 120_000);
});
