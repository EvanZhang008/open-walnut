/**
 * Phase 4 — task ops over the bridge RPC, with the offline queue as fallback.
 *
 * Locked down here:
 *   1. applyTaskOp (the extracted apply-one-op core, PRIMARY side): create /
 *      update-with-whitelist / delete / LWW-stale / replay short-circuit, all
 *      reported through the { applied, reason } contract the RPC returns.
 *   2. dispatchTaskOp (CLOUD side) happy path: one `server.tasks.apply` relay
 *      call, NOTHING written to disk — the dual-write is dead.
 *   3. bridge_offline → the op lands in cache/task-queue/ (NON-git) and NOT in
 *      the git tasks/outbox/.
 *   4. needs_upgrade → the DUAL fallback: queue file AND the legacy git outbox
 *      file, because an old primary can never answer this action and a
 *      queue-only fallback would strand the op until the Mac upgrades.
 *   5. A domain rejection is dropped (a retry would fail identically forever).
 *   6. flushTaskQueue: drains oldest-first, deletes on success, keeps on
 *      transport failure, drops unreadable files, and caps a sweep.
 *
 * Real files, real task store — constants redirected to a temp home. Only the
 * relay (network) is mocked, at the v1-control-relay seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

const constantsBase = createMockConstants('walnut-task-queue');

type RelayReply =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; failure: { kind: 'needs_upgrade' | 'bridge_offline'; message: string } }
  | { ok: false; failure: { kind: 'error'; status: number; code: string; message: string } };

const relayCalls: Array<{ action: string; sessionId: string; params: unknown }> = [];
let relayReply: RelayReply = { ok: true, result: { applied: true, reason: 'created' } };
let relayImpl: ((action: string, params: unknown) => RelayReply) | null = null;
/** Captured by the bridge-registry mock — the cloud's reconnect drain trigger. */
let bridgeConnectedHandler: (() => void) | null = null;

vi.mock('../../src/web/routes/v1-control-relay.js', () => ({
  callPrimaryControl: async (action: string, sessionId: string, params: unknown) => {
    relayCalls.push({ action, sessionId, params });
    return relayImpl ? relayImpl(action, params) : relayReply;
  },
}));

type Modules = {
  queue: typeof import('../../src/core/task-queue.js');
  outbox: typeof import('../../src/core/task-outbox.js');
  tm: typeof import('../../src/core/task-manager.js');
  taskDb: typeof import('../../src/core/task-db.js');
};

async function load(cloud: boolean): Promise<Modules> {
  vi.resetModules();
  vi.doMock('../../src/constants.js', () => ({ ...constantsBase, CLOUD_MODE: cloud }));
  vi.doMock('../../src/web/routes/v1-control-relay.js', () => ({
    callPrimaryControl: async (action: string, sessionId: string, params: unknown) => {
      relayCalls.push({ action, sessionId, params });
      return relayImpl ? relayImpl(action, params) : relayReply;
    },
  }));
  vi.doMock('../../src/web/ws/bridge-registry.js', () => ({
    setPrimaryBridgeConnectedHandler: (h: (() => void) | null) => { bridgeConnectedHandler = h; },
  }));
  return {
    queue: await import('../../src/core/task-queue.js'),
    outbox: await import('../../src/core/task-outbox.js'),
    tm: await import('../../src/core/task-manager.js'),
    taskDb: await import('../../src/core/task-db.js'),
  };
}

const QUEUE_DIR = constantsBase.TASK_QUEUE_DIR as string;
const OUTBOX_DIR = path.join(constantsBase.TASKS_DIR as string, 'outbox');

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

let current: Modules | undefined;

async function wipeHome(mods?: Modules): Promise<void> {
  if (mods) {
    mods.taskDb.closeDb();
    mods.tm._resetForTesting();
  }
  await fsp.rm(constantsBase.WALNUT_HOME as string, { recursive: true, force: true });
  await fsp.mkdir(constantsBase.TASKS_DIR as string, { recursive: true });
}

beforeEach(async () => {
  await wipeHome(current);
  relayCalls.length = 0;
  relayImpl = null;
  bridgeConnectedHandler = null;
  relayReply = { ok: true, result: { applied: true, reason: 'created' } };
});

afterEach(async () => {
  await wipeHome(current);
  current = undefined;
  vi.resetModules();
});

function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: 'op-task-1', title: 'from the phone', status: 'todo', phase: 'TODO', priority: 'none',
    project: '', source: 'local', session_ids: [],
    description: '', summary: '', note: '', created_at: now, updated_at: now,
    ...over,
  };
}

// ── PRIMARY side: the extracted apply-one-op core ───────────────────────────

describe('applyTaskOp (primary apply core)', () => {
  it('create inserts with the SAME id and reports reason "created"', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const res = await outbox.applyTaskOp({
      opId: 'a1', type: 'create', at: new Date().toISOString(),
      task: snapshot({ project: 'Walnut' }) as never,
    });
    expect(res).toEqual({ applied: true, reason: 'created' });
    const created = await tm.getTask('op-task-1');
    expect(created.title).toBe('from the phone');
    expect(created.project).toBe('Walnut');
  });

  it('a REPLAYED opId short-circuits without touching the store', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const op = {
      opId: 'replay-1', type: 'create' as const, at: new Date().toISOString(),
      task: snapshot() as never,
    };
    expect((await outbox.applyTaskOp(op)).applied).toBe(true);
    // Local edit after the op; a replay must not undo it.
    await tm.updateTask('op-task-1', { title: 'local edit' });
    expect(await outbox.applyTaskOp(op)).toEqual({ applied: false, reason: 'replay' });
    expect((await tm.getTask('op-task-1')).title).toBe('local edit');
  });

  it('update applies whitelisted fields only; a stale snapshot reports "stale"', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'local truth', source: 'local' });
    const localAt = (await tm.getTask(task.id)).updated_at;

    const staleAt = new Date(Date.parse(localAt) - 60_000).toISOString();
    expect(await outbox.applyTaskOp({
      opId: 's1', type: 'update', at: staleAt,
      task: { ...task, title: 'STALE', updated_at: staleAt } as never,
    })).toEqual({ applied: false, reason: 'stale' });
    expect((await tm.getTask(task.id)).title).toBe('local truth');

    const freshAt = new Date(Date.parse(localAt) + 60_000).toISOString();
    expect(await outbox.applyTaskOp({
      opId: 'f1', type: 'update', at: freshAt,
      task: {
        ...task, title: 'phone rename', updated_at: freshAt,
        source: 'ms-todo', external_url: 'https://evil.example',
      } as never,
    })).toEqual({ applied: true, reason: 'updated' });
    const after = await tm.getTask(task.id);
    expect(after.title).toBe('phone rename');
    expect(after.source).toBe('local');          // not whitelisted
    expect(after.external_url).toBeUndefined();  // not whitelisted
  });

  it('delete removes the row; deleting a missing row reports "missing" (idempotent)', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'doomed', source: 'local' });
    expect(await outbox.applyTaskOp({
      opId: 'd1', type: 'delete', at: new Date().toISOString(), id: task.id,
    })).toEqual({ applied: true, reason: 'deleted' });
    await expect(tm.getTask(task.id)).rejects.toThrow(/No task found/);

    expect(await outbox.applyTaskOp({
      opId: 'd2', type: 'delete', at: new Date().toISOString(), id: 'never-existed',
    })).toEqual({ applied: false, reason: 'missing' });
  });
});

// ── CLOUD side: dispatch + fallback ladder ──────────────────────────────────

describe('dispatchTaskOp (cloud → primary RPC, with fallbacks)', () => {
  it('happy path: one server.tasks.apply relay call and NOTHING written to disk', async () => {
    current = await load(true);
    const { queue } = current;

    await queue.dispatchTaskOp({ type: 'create', task: snapshot() as never });

    expect(relayCalls.length).toBe(1);
    expect(relayCalls[0].action).toBe('server.tasks.apply');
    expect(relayCalls[0].sessionId).toBe('__server__');
    const sent = (relayCalls[0].params as { op: { type: string; task: { id: string } } }).op;
    expect(sent.type).toBe('create');
    expect(sent.task.id).toBe('op-task-1');
    // The whole point: no git outbox file, no queue file.
    expect(await listJson(OUTBOX_DIR)).toEqual([]);
    expect(await listJson(QUEUE_DIR)).toEqual([]);
  });

  it('bridge offline → op queued under cache/task-queue, git outbox untouched', async () => {
    current = await load(true);
    const { queue } = current;
    relayReply = { ok: false, failure: { kind: 'bridge_offline', message: 'no live bridge' } };

    await queue.dispatchTaskOp({ type: 'update', task: snapshot() as never });

    const queued = await listJson(QUEUE_DIR);
    expect(queued.length).toBe(1);
    expect(await listJson(OUTBOX_DIR)).toEqual([]);
    const op = JSON.parse(await fsp.readFile(path.join(QUEUE_DIR, queued[0]), 'utf-8'));
    expect(op.type).toBe('update');
    expect(op.task.id).toBe('op-task-1');
    expect(await queue.queuedTaskOpCount()).toBe(1);
  });

  it('needs_upgrade → DUAL fallback: queue file AND the legacy git outbox file', async () => {
    current = await load(true);
    const { queue } = current;
    relayReply = { ok: false, failure: { kind: 'needs_upgrade', message: 'Unknown control action' } };

    await queue.dispatchTaskOp({ type: 'delete', id: 'gone-1' });

    const queued = await listJson(QUEUE_DIR);
    const legacy = await listJson(OUTBOX_DIR);
    expect(queued.length).toBe(1);
    expect(legacy.length).toBe(1);
    // Same op in both lanes — idempotent apply makes double delivery safe.
    expect(queued[0]).toBe(legacy[0]);
    const op = JSON.parse(await fsp.readFile(path.join(OUTBOX_DIR, legacy[0]), 'utf-8'));
    expect(op).toMatchObject({ type: 'delete', id: 'gone-1' });
  });

  it('a domain rejection is dropped — never queued, never retried', async () => {
    current = await load(true);
    const { queue } = current;
    relayReply = { ok: false, failure: { kind: 'error', status: 400, code: 'bad_request', message: 'op too large' } };

    await queue.dispatchTaskOp({ type: 'create', task: snapshot() as never });

    expect(await listJson(QUEUE_DIR)).toEqual([]);
    expect(await listJson(OUTBOX_DIR)).toEqual([]);
  });

  it('is a no-op on the primary box (dispatch only exists on the replica)', async () => {
    current = await load(false);
    await current.queue.dispatchTaskOp({ type: 'create', task: snapshot() as never });
    expect(relayCalls.length).toBe(0);
    expect(await listJson(QUEUE_DIR)).toEqual([]);
  });
});

describe('flushTaskQueue', () => {
  it('drains the queue oldest-first on success and deletes each sent file', async () => {
    current = await load(true);
    const { queue } = current;

    // Bank three ops while the bridge is down.
    relayReply = { ok: false, failure: { kind: 'bridge_offline', message: 'down' } };
    for (const id of ['q-1', 'q-2', 'q-3']) {
      await queue.dispatchTaskOp({ type: 'create', task: snapshot({ id }) as never });
    }
    expect(await queue.queuedTaskOpCount()).toBe(3);

    // Bridge comes back.
    relayCalls.length = 0;
    relayReply = { ok: true, result: { applied: true, reason: 'created' } };
    expect(await queue.flushTaskQueue()).toBe(3);
    expect(await queue.queuedTaskOpCount()).toBe(0);
    const sentIds = relayCalls.map((c) => (c.params as { op: { task?: { id: string } } }).op.task?.id);
    expect(sentIds).toEqual(['q-1', 'q-2', 'q-3']); // oldest-first (opIds sort chronologically)
  });

  it('keeps the ops when the bridge is still down, and stops after the first failure', async () => {
    current = await load(true);
    const { queue } = current;

    relayReply = { ok: false, failure: { kind: 'bridge_offline', message: 'down' } };
    for (const id of ['k-1', 'k-2']) {
      await queue.dispatchTaskOp({ type: 'create', task: snapshot({ id }) as never });
    }
    relayCalls.length = 0;
    expect(await queue.flushTaskQueue()).toBe(0);
    expect(await queue.queuedTaskOpCount()).toBe(2); // nothing lost
    expect(relayCalls.length).toBe(1);               // bailed after the first failure
  });

  it('a successful dispatch opportunistically drains what the outage banked', async () => {
    current = await load(true);
    const { queue } = current;

    relayReply = { ok: false, failure: { kind: 'bridge_offline', message: 'down' } };
    await queue.dispatchTaskOp({ type: 'create', task: snapshot({ id: 'banked-1' }) as never });
    expect(await queue.queuedTaskOpCount()).toBe(1);

    relayReply = { ok: true, result: { applied: true, reason: 'created' } };
    await queue.dispatchTaskOp({ type: 'create', task: snapshot({ id: 'live-1' }) as never });
    // The flush is fire-and-forget inside dispatch — give it a tick.
    for (let i = 0; i < 40 && (await queue.queuedTaskOpCount()) > 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await queue.queuedTaskOpCount()).toBe(0);
  });

  it('drops an unreadable queue file instead of wedging behind it', async () => {
    current = await load(true);
    const { queue } = current;

    await fsp.mkdir(QUEUE_DIR, { recursive: true });
    await fsp.writeFile(path.join(QUEUE_DIR, '000000000000001-0000.json'), '{{{ not json');
    relayReply = { ok: false, failure: { kind: 'bridge_offline', message: 'down' } };
    await queue.dispatchTaskOp({ type: 'create', task: snapshot({ id: 'good-1' }) as never });

    relayReply = { ok: true, result: { applied: true, reason: 'created' } };
    expect(await queue.flushTaskQueue()).toBe(1); // the good one
    expect(await queue.queuedTaskOpCount()).toBe(0); // garbage removed too
  });
});

// ── PRIMARY side: the RPC entry point (payload validation) ──────────────────

describe('server.tasks.apply relay handler', () => {
  async function relay(params: unknown): Promise<Record<string, unknown>> {
    const { handleSessionControlRelay } = await import('../../src/core/sessions/session-controls.js');
    return await handleSessionControlRelay('server.tasks.apply', '__server__', params) as
      unknown as Record<string, unknown>;
  }

  it('applies a valid op and returns { applied, reason, opId }', async () => {
    current = await load(false);
    const { tm } = current;

    const out = await relay({ op: { opId: 'rpc-1', type: 'create', at: new Date().toISOString(), task: snapshot() } });
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ applied: true, reason: 'created', opId: 'rpc-1' });
    expect((await tm.getTask('op-task-1')).title).toBe('from the phone');
  });

  it('rejects a malformed op with a bad_request errorKind (never throws)', async () => {
    current = await load(false);

    // Missing opId.
    expect(await relay({ op: { type: 'create', task: snapshot() } }))
      .toMatchObject({ ok: false, errorKind: 'bad_request' });
    // Unknown type.
    expect(await relay({ op: { opId: 'x', type: 'frobnicate', task: snapshot() } }))
      .toMatchObject({ ok: false, errorKind: 'bad_request' });
    // create without a task.
    expect(await relay({ op: { opId: 'x', type: 'create' } }))
      .toMatchObject({ ok: false, errorKind: 'bad_request' });
    // delete without an id.
    expect(await relay({ op: { opId: 'x', type: 'delete' } }))
      .toMatchObject({ ok: false, errorKind: 'bad_request' });
    // No updated_at → the LWW clock is missing, which could clobber a newer row.
    expect(await relay({ op: { opId: 'x', type: 'update', task: { ...snapshot(), updated_at: undefined } } }))
      .toMatchObject({ ok: false, errorKind: 'bad_request' });
  });

  it('rejects an oversized op instead of relaying it', async () => {
    current = await load(false);
    const huge = await relay({
      op: {
        opId: 'big-1', type: 'create',
        task: snapshot({ description: 'x'.repeat(300 * 1024) }),
      },
    });
    expect(huge).toMatchObject({ ok: false, errorKind: 'bad_request' });
    expect(String(huge.error)).toMatch(/too large/i);
  });

  it('an OLD primary (unknown action) answers the needs_upgrade ladder verbatim', async () => {
    current = await load(false);
    const { handleSessionControlRelay } = await import('../../src/core/sessions/session-controls.js');
    const out = await handleSessionControlRelay('server.tasks.apply.v99', '__server__', {});
    expect(out.ok).toBe(false);
    // classifyRelayReply keys off exactly this prefix → 'needs_upgrade'.
    expect(String((out as { error: string }).error)).toMatch(/^Unknown control action/);
  });
});

// ── Drain triggers ──────────────────────────────────────────────────────────

describe('startTaskQueueFlush drain triggers', () => {
  it('drains the queue when the primary bridge reconnects (no 60s wait)', async () => {
    current = await load(true);
    const { queue } = current;

    relayReply = { ok: false, failure: { kind: 'bridge_offline', message: 'down' } };
    await queue.dispatchTaskOp({ type: 'create', task: snapshot({ id: 'reconnect-1' }) as never });
    expect(await queue.queuedTaskOpCount()).toBe(1);

    const handle = queue.startTaskQueueFlush();
    try {
      // The hook registration is async (dynamic import of the transport module).
      for (let i = 0; i < 40 && !bridgeConnectedHandler; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(typeof bridgeConnectedHandler).toBe('function');

      relayReply = { ok: true, result: { applied: true, reason: 'created' } };
      bridgeConnectedHandler?.();
      for (let i = 0; i < 40 && (await queue.queuedTaskOpCount()) > 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(await queue.queuedTaskOpCount()).toBe(0);
    } finally {
      handle.stop();
    }
    // stop() unhooks so a stopped server can't be re-entered by a late redial.
    expect(bridgeConnectedHandler).toBeNull();
  });

  it('needs_upgrade keeps the queued copy and writes the legacy file exactly ONCE', async () => {
    current = await load(true);
    const { queue } = current;
    relayReply = { ok: false, failure: { kind: 'needs_upgrade', message: 'Unknown control action' } };

    await queue.dispatchTaskOp({ type: 'create', task: snapshot({ id: 'skew-1' }) as never });
    const legacy = await listJson(OUTBOX_DIR);
    expect(legacy.length).toBe(1);
    const firstWrite = (await fsp.stat(path.join(OUTBOX_DIR, legacy[0]))).mtimeMs;

    // Repeated sweeps against the same old primary must NOT re-touch the
    // git-tracked file (that churn is exactly what Phase 4 removes).
    await new Promise((r) => setTimeout(r, 10));
    await queue.flushTaskQueue();
    await queue.flushTaskQueue();
    expect(await listJson(OUTBOX_DIR)).toEqual(legacy);
    expect((await fsp.stat(path.join(OUTBOX_DIR, legacy[0]))).mtimeMs).toBe(firstWrite);
    // The queued copy survives — it is what converges once the Mac upgrades.
    expect(await queue.queuedTaskOpCount()).toBe(1);

    // Mac upgraded: the very next sweep applies it and clears the queue.
    relayReply = { ok: true, result: { applied: true, reason: 'created' } };
    expect(await queue.flushTaskQueue()).toBe(1);
    expect(await queue.queuedTaskOpCount()).toBe(0);
  });
});
