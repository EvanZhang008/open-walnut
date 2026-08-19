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

// ── Scoped update ops (touched / append / order) — write-parity 2026-08 ─────

describe('applyTaskOp: scoped updates (touched)', () => {
  it('a touched-scoped op applies ONLY the named fields — untouched blobs survive', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'primary truth', source: 'local' });
    await tm.updateDescription(task.id, 'primary description');
    await tm.updateNote(task.id, 'primary note');
    const row = await tm.getTask(task.id);

    // A replica title edit: the replica row is projection-blind (description/
    // note are ''), and its snapshot says so — but touched scopes the patch.
    const freshAt = new Date(Date.parse(row.updated_at) + 60_000).toISOString();
    expect(await outbox.applyTaskOp({
      opId: 'sc-1', type: 'update', at: freshAt, touched: ['title'],
      task: { ...row, title: 'phone title', description: '', note: '', summary: '', updated_at: freshAt } as never,
    })).toEqual({ applied: true, reason: 'updated' });
    const after = await tm.getTask(task.id);
    expect(after.title).toBe('phone title');
    expect(after.description).toBe('primary description');
    expect(after.note).toBe('primary note');
  });

  it('a touched field ABSENT from the snapshot is an explicit clear (unpin case)', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'pinned one', source: 'local' });
    await tm.togglePin(task.id);
    const row = await tm.getTask(task.id);
    expect(row.pinned).toBe(true);

    const freshAt = new Date(Date.parse(row.updated_at) + 60_000).toISOString();
    const { pinned: _p, pin_order: _o, focus_tier: _f, ...unpinned } = row as Record<string, unknown>;
    expect(await outbox.applyTaskOp({
      opId: 'sc-2', type: 'update', at: freshAt,
      touched: ['pinned', 'pin_order', 'focus_tier'],
      task: { ...unpinned, pinned: false, updated_at: freshAt } as never,
    })).toEqual({ applied: true, reason: 'updated' });
    const after = await tm.getTask(task.id);
    expect(after.pinned).toBe(false);
    expect(after.pin_order).toBeUndefined();
    expect(after.focus_tier).toBeUndefined();
  });

  it('LEGACY op (no touched): empty note/description are skipped, summary never applies', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'legacy target', source: 'local' });
    await tm.updateDescription(task.id, 'real description');
    await tm.updateNote(task.id, 'real note');
    await tm.updateSummary(task.id, 'full summary the projection would truncate');
    const row = await tm.getTask(task.id);

    const freshAt = new Date(Date.parse(row.updated_at) + 60_000).toISOString();
    expect(await outbox.applyTaskOp({
      opId: 'lg-1', type: 'update', at: freshAt,
      task: {
        ...row, title: 'legacy rename', updated_at: freshAt,
        description: '', note: '', summary: 'truncated…',
      } as never,
    })).toEqual({ applied: true, reason: 'updated' });
    const after = await tm.getTask(task.id);
    expect(after.title).toBe('legacy rename');
    expect(after.description).toBe('real description');   // '' skipped
    expect(after.note).toBe('real note');                  // '' skipped
    expect(after.summary).toBe('full summary the projection would truncate'); // never applied
  });

  it('append.note concatenates onto the PRIMARY note instead of replacing it', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'note target', source: 'local' });
    await tm.updateNote(task.id, 'existing primary note');
    const row = await tm.getTask(task.id);

    const freshAt = new Date(Date.parse(row.updated_at) + 60_000).toISOString();
    expect(await outbox.applyTaskOp({
      opId: 'ap-1', type: 'update', at: freshAt, touched: ['note'],
      append: { note: 'appended from the phone' },
      task: { ...row, note: 'appended from the phone', updated_at: freshAt } as never,
    })).toEqual({ applied: true, reason: 'updated' });
    expect((await tm.getTask(task.id)).note).toBe('existing primary note\n\nappended from the phone');
  });

  it('a touched human reopen un-completes a terminal primary row', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'done one', source: 'local' });
    await tm.completeTask(task.id);
    const row = await tm.getTask(task.id);
    expect(row.phase).toBe('COMPLETE');

    const freshAt = new Date(Date.parse(row.updated_at) + 60_000).toISOString();
    expect(await outbox.applyTaskOp({
      opId: 'ro-1', type: 'update', at: freshAt, touched: ['status', 'phase'],
      task: { ...row, status: 'todo', phase: 'TODO', completed_at: undefined, updated_at: freshAt } as never,
    })).toEqual({ applied: true, reason: 'updated' });
    const after = await tm.getTask(task.id);
    expect(after.phase).toBe('TODO');
    expect(after.status).toBe('todo');
  });

  it('a project move mints the registry row (same as create)', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'mover', source: 'local' });
    const row = await tm.getTask(task.id);
    const freshAt = new Date(Date.parse(row.updated_at) + 60_000).toISOString();
    expect(await outbox.applyTaskOp({
      opId: 'pm-1', type: 'update', at: freshAt, touched: ['project'],
      task: { ...row, project: 'BrandNewProject', updated_at: freshAt } as never,
    })).toEqual({ applied: true, reason: 'updated' });
    expect((await tm.getTask(task.id)).project).toBe('BrandNewProject');
    expect(await tm.getProjectRecord('brandnewproject')).toMatchObject({ name: 'BrandNewProject' });
  });

  it('depends_on rides a touched op through cycle validation', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task: a } = await tm.addTask({ title: 'dep A', source: 'local' });
    const { task: b } = await tm.addTask({ title: 'dep B', source: 'local' });
    const rowA = await tm.getTask(a.id);
    const freshAt = new Date(Date.parse(rowA.updated_at) + 60_000).toISOString();
    expect(await outbox.applyTaskOp({
      opId: 'dp-1', type: 'update', at: freshAt, touched: ['depends_on'],
      task: { ...rowA, depends_on: [b.id], updated_at: freshAt } as never,
    })).toEqual({ applied: true, reason: 'updated' });
    expect((await tm.getTask(a.id)).depends_on).toEqual([b.id]);

    // A self-cycle is refused by validation but still CONSUMES the op.
    const rowB = await tm.getTask(b.id);
    const at2 = new Date(Date.parse(rowB.updated_at) + 60_000).toISOString();
    await outbox.applyTaskOp({
      opId: 'dp-2', type: 'update', at: at2, touched: ['depends_on'],
      task: { ...rowB, depends_on: [a.id], updated_at: at2 } as never, // b→a while a→b = cycle
    });
    expect((await tm.getTask(b.id)).depends_on).toBeUndefined();
  });
});

// ── depends_on: a validation refusal vs an INFRASTRUCTURE failure ───────────
//
// These two must not share a fate. The depends_on write is the one field
// applyTaskOp routes back through updateTask (for existence + cycle checks), so
// it is the one field whose failure can be misread. An unconditional catch there
// relabelled a write-lock timeout / EIO as "validation rejected", dropped the
// field, and then let the fall-through updateTaskRaw report `applied: true` —
// which stood BOTH safety layers down at once:
//
//   1. PRIMARY: rememberOpId() ran, so a re-delivery of the same opId is
//      refused as a replay for the whole 500-op window.
//   2. REPLICA: task-queue's dispatch returns early WITHOUT enqueue() on a
//      truthy outcome, so no copy was ever banked.
//
// Nobody held the user's dependency edit, and there was no error to act on. The
// (a) test below pins the primary half (the op must NOT be consumed) and the
// replica half (a primary 5xx must be queued, not dropped as a refusal); (b)
// pins that a genuine validation refusal still consumes the op, because a retry
// would be refused identically forever.
describe('applyTaskOp: depends_on failure is classified, not swallowed', () => {
  it('(a) an INFRA failure propagates — the op is NOT consumed and a retry lands the edge', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task: a } = await tm.addTask({ title: 'infra A', source: 'local' });
    const { task: b } = await tm.addTask({ title: 'infra B', source: 'local' });
    const rowA = await tm.getTask(a.id);
    const freshAt = new Date(Date.parse(rowA.updated_at) + 60_000).toISOString();
    const op = {
      opId: 'infra-1', type: 'update' as const, at: freshAt, touched: ['depends_on'],
      task: { ...rowA, depends_on: [b.id], updated_at: freshAt } as never,
    };

    // Spy on the REAL task-manager singleton, never a vi.mock module factory:
    // task-outbox reaches it through `await import('./task-manager.js')`, which
    // a factory does not reliably rebind (see 751a8f3f — the miss is silent).
    const spy = vi.spyOn(tm, 'updateTask').mockRejectedValueOnce(new Error('withWriteLock timeout'));
    try {
      await expect(outbox.applyTaskOp(op)).rejects.toThrow(/withWriteLock timeout/);
    } finally {
      spy.mockRestore();
    }
    // The edge did not land, and — the part that used to lose data — the op was
    // never marked consumed, so the SAME op still applies on a retry.
    expect((await tm.getTask(a.id)).depends_on).toBeUndefined();
    expect(await outbox.applyTaskOp(op)).toEqual({ applied: true, reason: 'updated' });
    expect((await tm.getTask(a.id)).depends_on).toEqual([b.id]);
  });

  it('(a2) REPLICA half: a primary 5xx is banked for retry, not dropped as a refusal', async () => {
    current = await load(true);
    const { queue } = current;

    // What the relay actually reports when applyTaskOp throws: errorKind
    // 'internal' → status 500. Classifying that as a domain refusal would drop
    // the op and re-open the loss from the other end.
    relayReply = {
      ok: false,
      failure: { kind: 'error', status: 500, code: 'internal', message: 'withWriteLock timeout' },
    };
    await queue.dispatchTaskOp({ type: 'update', task: snapshot({ id: 'infra-op-1' }) as never });
    expect(await queue.queuedTaskOpCount()).toBe(1);

    // …and it converges once the primary recovers.
    relayReply = { ok: true, result: { applied: true, reason: 'updated' } };
    expect(await queue.flushTaskQueue()).toBe(1);
    expect(await queue.queuedTaskOpCount()).toBe(0);

    // Contrast: a 4xx refusal is still dropped (a retry is refused identically).
    relayReply = {
      ok: false,
      failure: { kind: 'error', status: 400, code: 'bad_request', message: 'op too large' },
    };
    await queue.dispatchTaskOp({ type: 'update', task: snapshot({ id: 'refused-1' }) as never });
    expect(await queue.queuedTaskOpCount()).toBe(0);
  });

  it('(b) a VALIDATION refusal consumes the op — other fields apply, a replay is refused', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    // Real cycle: A depends on B, then the op asks for B → A.
    const { task: a } = await tm.addTask({ title: 'cycle A', source: 'local' });
    const { task: b } = await tm.addTask({ title: 'cycle B', source: 'local' });
    await tm.updateTask(a.id, { set_depends_on: [b.id] });

    const rowB = await tm.getTask(b.id);
    const freshAt = new Date(Date.parse(rowB.updated_at) + 60_000).toISOString();
    const op = {
      opId: 'cyc-1', type: 'update' as const, at: freshAt, touched: ['depends_on', 'title'],
      task: { ...rowB, title: 'renamed anyway', depends_on: [a.id], updated_at: freshAt } as never,
    };

    expect(await outbox.applyTaskOp(op)).toEqual({ applied: true, reason: 'updated' });
    const after = await tm.getTask(b.id);
    expect(after.depends_on).toBeUndefined();      // the cycle was refused
    expect(after.title).toBe('renamed anyway');    // the rest of the op still landed
    // Consumed: replaying it changes nothing (a retry would be refused too).
    expect(await outbox.applyTaskOp(op)).toEqual({ applied: false, reason: 'replay' });
    expect((await tm.getTask(b.id)).depends_on).toBeUndefined();
  });

  it('(b2) a non-existent dependency target is a validation refusal too, not an infra error', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'dangling dep', source: 'local' });
    const row = await tm.getTask(task.id);
    const freshAt = new Date(Date.parse(row.updated_at) + 60_000).toISOString();
    // Must not throw: the target id will never exist, so retrying forever is
    // pointless — consume the op and keep the rest of the edit.
    expect(await outbox.applyTaskOp({
      opId: 'dangle-1', type: 'update', at: freshAt, touched: ['depends_on', 'title'],
      task: { ...row, title: 'renamed', depends_on: ['no-such-task-9999'], updated_at: freshAt } as never,
    })).toEqual({ applied: true, reason: 'updated' });
    const after = await tm.getTask(task.id);
    expect(after.depends_on).toBeUndefined();
    expect(after.title).toBe('renamed');
  });
});

describe('applyTaskOp: order ops', () => {
  it('reorder permutes a project group; reorder-pins rewrites pin_order', async () => {
    current = await load(false);
    const { outbox, tm } = current;

    const t1 = (await tm.addTask({ title: 'r1', source: 'local' })).task;
    const t2 = (await tm.addTask({ title: 'r2', source: 'local' })).task;
    const t3 = (await tm.addTask({ title: 'r3', source: 'local' })).task;

    expect(await outbox.applyTaskOp({
      opId: 'or-1', type: 'reorder', at: new Date().toISOString(),
      project: '', taskIds: [t3.id, t1.id, t2.id],
    })).toEqual({ applied: true, reason: 'reordered' });
    const inbox = (await tm.listTasks()).filter((t) => !t.project).map((t) => t.id);
    expect(inbox).toEqual([t3.id, t1.id, t2.id]);

    await tm.togglePin(t1.id);
    await tm.togglePin(t2.id);
    expect(await outbox.applyTaskOp({
      opId: 'or-2', type: 'reorder-pins', at: new Date().toISOString(),
      taskIds: [t2.id, t1.id],
    })).toEqual({ applied: true, reason: 'reordered' });
    const pinned = await tm.getPinnedTasks();
    expect(pinned.map((t) => t.id)).toEqual([t2.id, t1.id]);
  });

  it('relay handler validates order ops (shape + project required for reorder)', async () => {
    current = await load(false);
    const { handleSessionControlRelay } = await import('../../src/core/sessions/session-controls.js');
    const relay = async (op: unknown) =>
      await handleSessionControlRelay('server.tasks.apply', '__server__', { op }) as Record<string, unknown>;

    expect(await relay({ opId: 'x', type: 'reorder', taskIds: [] }))
      .toMatchObject({ ok: false, errorKind: 'bad_request' });
    expect(await relay({ opId: 'x', type: 'reorder', taskIds: ['a'] })) // no project
      .toMatchObject({ ok: false, errorKind: 'bad_request' });
    expect(await relay({ opId: 'x', type: 'reorder-pins', taskIds: [42] }))
      .toMatchObject({ ok: false, errorKind: 'bad_request' });
    const ok = await relay({ opId: 'ok-1', type: 'reorder', project: '', taskIds: ['nope'] });
    expect(ok.ok).toBe(true); // unknown ids self-heal to a no-op, still consumed
  });
});

describe('dispatchTaskOp: order ops and the legacy lane', () => {
  it('order ops queue on bridge_offline but NEVER write the legacy git outbox on needs_upgrade', async () => {
    current = await load(true);
    const { queue } = current;

    relayReply = { ok: false, failure: { kind: 'needs_upgrade', message: 'Unknown control action' } };
    await queue.dispatchTaskOp({ type: 'reorder', project: '', taskIds: ['a', 'b'] });
    expect(await queue.queuedTaskOpCount()).toBe(1);
    expect(await listJson(OUTBOX_DIR)).toEqual([]); // an old primary can't parse it

    relayReply = { ok: false, failure: { kind: 'bridge_offline', message: 'down' } };
    await queue.dispatchTaskOp({ type: 'reorder-pins', taskIds: ['a'] });
    expect(await queue.queuedTaskOpCount()).toBe(2);
  });

  it('update dispatch carries touched + append through to the relay payload', async () => {
    current = await load(true);
    const { queue } = current;

    await queue.dispatchTaskOp({
      type: 'update', task: snapshot() as never,
      touched: ['note'], append: { note: 'appended entry' },
    });
    const sent = (relayCalls[0].params as { op: Record<string, unknown> }).op;
    expect(sent.touched).toEqual(['note']);
    expect(sent.append).toEqual({ note: 'appended entry' });
  });
});

describe('delete tombstones + projection-import guards', () => {
  it('a dispatched delete leaves a tombstone that blocks the projection echo', async () => {
    current = await load(true);
    const { queue } = current;

    relayReply = { ok: true, result: { applied: true, reason: 'deleted' } };
    await queue.dispatchTaskOp({ type: 'delete', id: 'tomb-1' });
    expect(queue.hasDeleteTombstone('tomb-1')).toBe(true);
    expect(queue.hasDeleteTombstone('someone-else')).toBe(false);
  });

  it('importProjectionOnCloud skips rows with a QUEUED op and tombstoned deletes', async () => {
    current = await load(true);
    const { queue, outbox, tm, taskDb } = current;

    // Local replica edit banked while offline (queued op) + a local delete.
    relayReply = { ok: false, failure: { kind: 'bridge_offline', message: 'down' } };
    const { task: edited } = await tm.addTask({ title: 'replica edit', source: 'local' });
    await tm.updateTask(edited.id, { title: 'replica newer title' });
    await queue.dispatchTaskOp({ type: 'update', task: await tm.getTask(edited.id) });
    await queue.dispatchTaskOp({ type: 'delete', id: 'deleted-on-replica' });

    // A projection frame built BEFORE those local writes arrives late.
    const staleAt = new Date(Date.now() + 60_000).toISOString(); // newer clock — would win LWW without the guard
    const projection = {
      version: 2, exportedAt: new Date().toISOString(),
      tasks: [
        { id: edited.id, title: 'stale echo title', status: 'todo', phase: 'TODO', priority: 'none', project: '', created_at: staleAt, updated_at: staleAt },
        { id: 'deleted-on-replica', title: 'zombie', status: 'todo', phase: 'TODO', priority: 'none', project: '', created_at: staleAt, updated_at: staleAt },
      ],
    };
    const { writeProjectionCache } = await import('../../src/core/projection-cache.js');
    await writeProjectionCache('tasks', projection);
    await outbox.importProjectionOnCloud();

    expect((await tm.getTask(edited.id)).title).toBe('replica newer title'); // queued-op guard
    await expect(tm.getTask('deleted-on-replica')).rejects.toThrow(/No task found/); // tombstone
    void taskDb;
  });

  it('the projection import adopts the custom-tier registry', async () => {
    current = await load(true);
    const { outbox, tm } = current;

    const projection = {
      version: 2, exportedAt: new Date().toISOString(), tasks: [],
      custom_tiers: [{ id: 'ct_abc12345', label: 'Deep Work' }],
    };
    const { writeProjectionCache } = await import('../../src/core/projection-cache.js');
    await writeProjectionCache('tasks', projection);
    await outbox.importProjectionOnCloud();
    expect(await tm.getCustomTiers()).toEqual([{ id: 'ct_abc12345', label: 'Deep Work' }]);
  });

  it('the projection import removes a primary-deleted row (guarded: never a fresh or pending one)', async () => {
    current = await load(true);
    const { queue, outbox, tm } = current;

    // Three replica rows: one stale (primary deleted it), one with a queued op,
    // one fresh. Backdate the stale + queued rows so only the guards differ.
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    await tm.addTasksBulk([
      { id: 'gone-on-mac', title: 'deleted on the Mac', status: 'todo', phase: 'TODO', priority: 'none', project: '', source: 'local', session_ids: [], description: '', summary: '', note: '', created_at: old, updated_at: old } as never,
      { id: 'queued-edit', title: 'has a banked op', status: 'todo', phase: 'TODO', priority: 'none', project: '', source: 'local', session_ids: [], description: '', summary: '', note: '', created_at: old, updated_at: old } as never,
    ]);
    const { task: fresh } = await tm.addTask({ title: 'fresh replica create', source: 'local' });
    relayReply = { ok: false, failure: { kind: 'bridge_offline', message: 'down' } };
    await queue.dispatchTaskOp({ type: 'update', task: await tm.getTask('queued-edit') });

    // Projection built now, WITHOUT any of the three rows.
    const { writeProjectionCache } = await import('../../src/core/projection-cache.js');
    await writeProjectionCache('tasks', { version: 2, exportedAt: new Date().toISOString(), tasks: [] });
    await outbox.importProjectionOnCloud();

    await expect(tm.getTask('gone-on-mac')).rejects.toThrow(/No task found/); // reconciled away
    expect((await tm.getTask('queued-edit')).title).toBe('has a banked op');  // pending-op guard
    expect((await tm.getTask(fresh.id)).title).toBe('fresh replica create');  // safety window
  });

  it('the projection import adopts the primary row ORDER (skipped after a local reorder)', async () => {
    current = await load(true);
    const { queue, outbox, tm } = current;

    const t1 = (await tm.addTask({ title: 'o1', source: 'local' })).task;
    const t2 = (await tm.addTask({ title: 'o2', source: 'local' })).task;
    const now = new Date(Date.now() - 60_000).toISOString(); // older than local rows → upserts skip
    const mkRow = (id: string, title: string) => ({
      id, title, status: 'todo', phase: 'TODO', priority: 'none', project: '',
      created_at: now, updated_at: now,
    });
    const { writeProjectionCache } = await import('../../src/core/projection-cache.js');

    // Primary says t2 before t1 → replica store aligns.
    await writeProjectionCache('tasks', {
      version: 2, exportedAt: new Date().toISOString(), tasks: [mkRow(t2.id, 'o2'), mkRow(t1.id, 'o1')],
    });
    await outbox.importProjectionOnCloud();
    expect((await tm.listTasks()).map((t) => t.id)).toEqual([t2.id, t1.id]);

    // Replica-side reorder → a late stale projection must NOT re-impose its order.
    relayReply = { ok: false, failure: { kind: 'bridge_offline', message: 'down' } };
    await queue.dispatchTaskOp({ type: 'reorder', project: '', taskIds: [t1.id, t2.id] });
    await tm.reorderTasks('', [t1.id, t2.id]);
    await writeProjectionCache('tasks', {
      version: 2, exportedAt: new Date().toISOString(), tasks: [mkRow(t2.id, 'o2'), mkRow(t1.id, 'o1')],
    });
    await outbox.importProjectionOnCloud();
    expect((await tm.listTasks()).map((t) => t.id)).toEqual([t1.id, t2.id]); // local order kept
  });
});

describe('server.tasks.get (full-row readback relay, primary side)', () => {
  it('answers the full task row; 404s an unknown id', async () => {
    current = await load(false);
    const { tm } = current;
    const { handleSessionControlRelay } = await import('../../src/core/sessions/session-controls.js');

    const { task } = await tm.addTask({ title: 'readback target', source: 'local' });
    await tm.updateDescription(task.id, 'full primary description');

    const ok = await handleSessionControlRelay('server.tasks.get', '__server__', { id: task.id });
    expect(ok.ok).toBe(true);
    const row = (ok as { result: { task: Record<string, unknown> } }).result.task;
    expect(row.id).toBe(task.id);
    expect(row.description).toBe('full primary description');

    const missing = await handleSessionControlRelay('server.tasks.get', '__server__', { id: 'nope-1234' });
    expect(missing).toMatchObject({ ok: false, errorKind: 'not_found' });
  });
});
