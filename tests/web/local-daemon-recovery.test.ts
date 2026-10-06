/**
 * The 'local-daemon' condition has a lifecycle.
 *
 * 2026-10-05 19:20Z: on a loaded machine at deploy the daemon under the Walnut
 * Sessions host wrote its port file about 1.5s after the boot gave up, so the
 * boot logged "failed to start local daemon — local sessions will fail" (and the
 * host start line beside it), both keyless. The daemon then served for hours and
 * the cards stayed. Any later start that ends with a daemon serving is now the
 * recovery signal, and so is a boot that finds its daemon up while a card from
 * an earlier life is still open.
 *
 * Real server, real local daemon in this worker's isolated daemon dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';

let server: (Server & { address: () => { port: number } }) | undefined;
let previousDisableSearch: string | undefined;

async function feed() {
  const { listNotifications } = await import('../../src/core/notifications/store.js');
  return (await listNotifications()).feed;
}

async function pollFeed(pred: (f: Awaited<ReturnType<typeof feed>>) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = await feed();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
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

beforeAll(() => {
  previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH;
  process.env.WALNUT_DISABLE_SEARCH = '1';
});

afterAll(async () => {
  if (server) await shutdown();
  if (previousDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH;
  else process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch;
});

describe('local-daemon lifecycle', () => {
  it('a boot whose daemon is up retires the previous life\'s start card', async () => {
    const { upsertNotification } = await import('../../src/core/notifications/store.js');
    const { record } = await upsertNotification({
      kind: 'operation-error', severity: 'error',
      title: 'Failed to start local daemon — local sessions will fail',
      dedupKey: 'logerr:web:test-local-daemon-boot', recoveryKey: 'local-daemon',
    });
    expect(record.resolved).toBeUndefined();

    await boot();
    const settled = await pollFeed((f) =>
      f.some((n) => n.dedupKey === 'logerr:web:test-local-daemon-boot' && n.resolved === 'recovered'));
    expect(settled.find((n) => n.dedupKey === 'logerr:web:test-local-daemon-boot')?.resolved).toBe('recovered');
  }, 120_000);

  it('a start failure raised while running retires on the next start that ends with a daemon serving', async () => {
    const { log } = await import('../../src/logging/index.js');
    // The boot's failure line, with the key it now carries.
    log.web.error('failed to start local daemon — local sessions will fail', {
      error: 'Local daemon failed to start — port file not created within 30s (simulated)',
      recoveryKey: 'local-daemon',
    });
    const raised = await pollFeed((f) =>
      f.some((n) => n.recoveryKey === 'local-daemon' && n.kind === 'operation-error' && !n.resolved));
    const card = raised.find((n) => n.recoveryKey === 'local-daemon' && !n.resolved);
    expect(card).toBeDefined();

    // The next caller (a session start, a reconnect) finds the daemon serving.
    const { localDaemon } = await import('../../src/providers/local-daemon.js');
    await localDaemon.ensureRunning();
    const settled = await pollFeed((f) => f.some((n) => n.id === card!.id && n.resolved === 'recovered'));
    expect(settled.find((n) => n.id === card!.id)?.resolved).toBe('recovered');

    // A start with nothing failing publishes nothing (the edge, not every healthy call).
    const { record: other } = await (await import('../../src/core/notifications/store.js')).upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Unrelated card under the same key, raised by hand',
      dedupKey: 'logerr:web:test-local-daemon-quiet', recoveryKey: 'local-daemon',
    });
    await localDaemon.ensureRunning();
    await new Promise((r) => setTimeout(r, 300));
    expect((await feed()).find((n) => n.id === other.id)?.resolved).toBeUndefined();
    await shutdown();
  }, 120_000);
});
