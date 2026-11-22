/**
 * Unit test: gateway tools.list / tools.call — the op registry over the
 * daemon relay (docs/plan/unified-cli-mcp.md P2).
 *
 * Covers:
 * - tools.list returns the registry catalog (names + remote policy visible)
 * - tools.call refuses remote-denied (destructive) ops with a pointer to the
 *   local CLI
 * - tools.call validates payload shape (name string, args object)
 * - unknown op → bad_request with a catalog pointer
 * - writes consume the shared per-sender rate budget; reads never throttle
 *
 * The actual HTTP execution is NOT exercised here (executeOp hits the local
 * API); calls target an op that fails fast at the transport layer, asserting
 * only the pre-execution policy gates. Live round-trips are covered by
 * tests/mcp/ops-registry.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleGatewayCapability, type CapabilityRouterDeps } from '../../../src/core/peers/capability-router.js';
import {
  PeerThrottle, PEER_SEND_MAX_PER_WINDOW, GATEWAY_WRITE_MAX_PER_WINDOW, GATEWAY_WRITE_WINDOW_MS,
} from '../../../src/core/peers/peer-throttle.js';

const CALLER = 'a1b2c3d4-1111-2222-3333-444455556666';

/** The router's whole dependency surface after the peers fold: budget + posture. */
function deps(throttle = new PeerThrottle()): CapabilityRouterDeps {
  return { throttle, cloudMode: false };
}

describe('gateway tools.list with schemas (walnut mcp-server)', () => {
  it('lists every op the host may run, each with its JSON schema', async () => {
    const { listOps } = await import('../../../src/ops/index.js');
    const r = await handleGatewayCapability('tools.list', CALLER, { schemas: true }, 'devbox', deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ops = r.result.ops as Array<{ name: string; inputSchema?: { type?: string }; signature?: string }>;
    // Exactly the ops tools.call would run from this host: no tool the model is refused.
    const runnable = listOps().filter((o) => o.tags.remote !== 'deny').map((o) => o.name).sort();
    expect(ops.map((o) => o.name).sort()).toEqual(runnable);
    expect(ops.map((o) => o.name)).not.toContain('task_delete');
    for (const op of ops) expect(op.inputSchema?.type, op.name).toBe('object');
    const get = ops.find((o) => o.name === 'task_get') as { inputSchema: { required?: string[] } } | undefined;
    expect(get?.inputSchema.required).toEqual(['id']);
  });

  it('a session on this Mac also sees the host-local ops its gateway runs there', async () => {
    const { listOps } = await import('../../../src/ops/index.js');
    const local = listOps().filter((o) => o.tags.remote === 'deny' && o.tags.localHostGateway).map((o) => o.name);
    const r = await handleGatewayCapability('tools.list', CALLER, { schemas: true }, '__local__', deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = (r.result.ops as Array<{ name: string }>).map((o) => o.name);
    for (const name of local) expect(names, name).toContain(name);
    expect(names).not.toContain('task_delete');
  });
});

// Experiment mcp_tools_by_role (src/ops/op-groups.ts): a host server that asks for its role's
// list gets only that, an older one keeps every tool, and every tool still runs by name.
describe('gateway tools.list with schemas, per role', () => {
  const names = async (payload: Record<string, unknown>, role: 'worker' | 'org' | undefined) => {
    const asked: string[] = [];
    const d = { ...deps(), listingRole: async (sid: string) => { asked.push(sid); return role ? { role } : undefined; } };
    const r = await handleGatewayCapability('tools.list', CALLER, payload, 'devbox', d);
    expect(r.ok).toBe(true);
    return { names: r.ok ? (r.result.ops as Array<{ name: string }>).map((o) => o.name) : [], asked };
  };

  it('a worker\'s server lists the worker groups only; an org node\'s adds the org', async () => {
    const { listOps } = await import('../../../src/ops/index.js');
    const { listedForRole } = await import('../../../src/ops/op-groups.js');
    const worker = await names({ schemas: true, listing: 'role' }, 'worker');
    expect(worker.asked).toEqual([CALLER]);
    const expected = listOps().filter((o) => o.tags.remote !== 'deny' && listedForRole('worker', o.name)).map((o) => o.name).sort();
    expect(worker.names.sort()).toEqual(expected);
    expect(worker.names).toContain('task_get');
    expect(worker.names).toContain('host_exec');
    expect(worker.names).toContain('thread_list');
    expect(worker.names).not.toContain('org_get');
    expect(worker.names).not.toContain('topic_post');
    const org = await names({ schemas: true, listing: 'role' }, 'org');
    expect(org.names).toContain('org_get');
    expect(org.names).toContain('brief_write');
    expect(org.names).toContain('thread_update');
    expect(org.names).not.toContain('topic_post');
    // Still only what this host's gateway runs.
    expect(org.names).not.toContain('task_delete');
    expect(worker.names.length).toBeLessThan(org.names.length);
  });

  it('an older host server (no `listing`), the experiment off (no role) and a router keep their whole list', async () => {
    const { listOps } = await import('../../../src/ops/index.js');
    const all = listOps().filter((o) => o.tags.remote !== 'deny').map((o) => o.name).sort();
    const older = await names({ schemas: true }, 'worker');
    expect(older.asked).toEqual([]);
    expect(older.names.sort()).toEqual(all);
    const off = await names({ schemas: true, listing: 'role' }, undefined);
    expect(off.names.sort()).toEqual(all);
    const failing = { ...deps(), listingRole: async () => { throw new Error('store locked'); } };
    const r = await handleGatewayCapability('tools.list', CALLER, { schemas: true, listing: 'role' }, 'devbox', failing);
    expect(r.ok && (r.result.ops as unknown[]).length).toBe(all.length);
  });

  it('a plugin\'s ops: an org node lists them, a worker only those of the plugin its task comes from', async () => {
    const { definePluginOp } = await import('../../../src/ops/registry.js');
    const op = (name: string) => ({ name, title: name, description: name, input: {}, handler: async () => ({}), tags: { readonly: true, remote: 'allow' as const } });
    const mail = definePluginOp('listing-mail', op('listing_mail_read'));
    const sync = definePluginOp('listing-sync', op('listing_sync_status'));
    try {
      const list = async (listing: { role: 'worker' | 'org'; plugins?: string[] }) => {
        const r = await handleGatewayCapability('tools.list', CALLER, { schemas: true, listing: 'role' }, 'devbox', { ...deps(), listingRole: async () => listing });
        return r.ok ? (r.result.ops as Array<{ name: string }>).map((o) => o.name) : [];
      };
      const org = await list({ role: 'org' });
      expect(org).toContain('listing_mail_read');
      expect(org).toContain('listing_sync_status');
      const worker = await list({ role: 'worker' });
      expect(worker).not.toContain('listing_mail_read');
      expect(worker).not.toContain('listing_sync_status');
      const synced = await list({ role: 'worker', plugins: ['listing-sync'] });
      expect(synced).toContain('listing_sync_status');
      expect(synced).not.toContain('listing_mail_read');
    } finally { await mail.dispose(); await sync.dispose(); }
  });

  it('an op a worker does not list still runs by name: listing never refuses a call', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ groups: [] }), { status: 200 }));
    try {
      const d = { ...deps(), listingRole: async () => ({ role: 'worker' as const }) };
      const r = await handleGatewayCapability('tools.call', CALLER, { name: 'folder_list', args: {} }, 'devbox', d);
      expect(r.ok).toBe(true);
      expect(fetcher).toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });
});

describe('gateway tools.list', () => {
  it('names each op\'s group, and the groups in catalog order', async () => {
    const r = await handleGatewayCapability('tools.list', CALLER, {}, 'devbox', deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ops = r.result.ops as Array<{ name: string; group?: string }>;
    for (const op of ops) expect(op.group, op.name).toBeTruthy();
    expect(ops.find((o) => o.name === 'task_get')?.group).toBe('tasks');
    expect(ops.find((o) => o.name === 'board_post')?.group).toBe('board');
    const groups = r.result.groups as Array<{ id: string; title: string; count: number }>;
    expect(groups[0]).toMatchObject({ id: 'tasks' });
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(ops.length);
  });

  it('returns the registry catalog with names and remote policy', async () => {
    const r = await handleGatewayCapability('tools.list', CALLER, {}, 'devbox', deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ops = r.result.ops as Array<{ name: string; remote: string; readonly: boolean }>;
    const names = ops.map((o) => o.name);
    expect(names).toContain('task_list');
    expect(names).toContain('task_create');
    expect(names).toContain('api');
    // The ops that replaced the peers capabilities must be in the catalog a
    // remote session sees — otherwise the pointer in the retired branch is a
    // dead end (tests/unit/peers/capability-router.test.ts).
    expect(names).toContain('task_history');
    expect(names).toContain('task_send');
    expect(names).toContain('task_start');
    expect(names.some((name) => name.startsWith('session_'))).toBe(false);
    expect(names).toContain('request_get');
    expect(ops.find((o) => o.name === 'request_get')?.readonly).toBe(true);
    expect(ops.find((o) => o.name === 'task_send')?.readonly).toBe(false);
    const del = ops.find((o) => o.name === 'task_delete');
    expect(del?.remote).toBe('deny');
  });

  it('every row carries an argument signature (remote `tools list` showed none)', async () => {
    const r = await handleGatewayCapability('tools.list', CALLER, {}, 'devbox', deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ops = r.result.ops as Array<{ name: string; signature?: string; params?: unknown }>;
    for (const op of ops) expect(op.signature, op.name).toBeTruthy();
    expect(ops.find((o) => o.name === 'note_read')?.signature).toBe('path?, id?, offset?, section?');
    expect(ops.find((o) => o.name === 'walnut_status')?.signature).toBe('(none)');
    // The full catalog stays light: per-parameter descriptions ride only the
    // single-op request below.
    for (const op of ops) expect(op.params, op.name).toBeUndefined();
  });

  it('a named request answers with ONE op plus its full parameter rows', async () => {
    const r = await handleGatewayCapability('tools.list', CALLER, { name: 'note_edit' }, 'devbox', deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ops = r.result.ops as Array<{
      name: string
      params?: Array<{ name: string; type: string; required: boolean; description?: string }>
    }>;
    expect(ops).toHaveLength(1);
    expect(ops[0].name).toBe('note_edit');
    const params = ops[0].params ?? [];
    expect(params.map((p) => p.name)).toEqual(
      ['path', 'id', 'old_str', 'new_str', 'replace_all', 'expectedHash'],
    );
    expect(params.find((p) => p.name === 'old_str')).toMatchObject({ type: 'string', required: true });
    expect(params.find((p) => p.name === 'replace_all')?.required).toBe(false);
    expect(params.find((p) => p.name === 'old_str')?.description).toBeTruthy();
  });

  it('an unknown named op answers with an empty catalog, not the whole list', async () => {
    const r = await handleGatewayCapability('tools.list', CALLER, { name: 'nope_not_real' }, 'devbox', deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.ops).toEqual([]);
  });
});

describe('gateway tools.call — policy gates', () => {
  it('preserves the task id in an error when create succeeds but start fails', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: 'task-created', title: 'Start failure' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'bad_request', message: 'Missing cwd' } }), { status: 400 }));
    try {
      const result = await handleGatewayCapability('tools.call', CALLER,
        { name: 'task_create', args: { title: 'Start failure' } }, 'devbox', deps());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected partial write failure');
      expect(result.error.detail).toMatchObject({ task: { id: 'task-created' }, start_error: expect.stringContaining('Missing cwd') });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { fetcher.mockRestore(); }
  });

  it('an op the API answers with a status says which, so the relay log does not count it as a refusal', async () => {
    // 2026-11-15: 826 `api GET /api/sessions/<id>` 404s were logged as relay refusals ("internal").
    const answer = (status: number) => new Response(JSON.stringify({ error: 'Session not found' }), { status });
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(answer(404))
      .mockResolvedValueOnce(answer(404))
      .mockResolvedValueOnce(answer(503));
    try {
      const viaApi = await handleGatewayCapability('tools.call', CALLER,
        { name: 'api', args: { method: 'GET', path: '/api/sessions/no-such-session' } }, 'devbox', deps());
      expect(viaApi).toMatchObject({ ok: false, opStatus: 404, error: { code: 'internal' } });
      const bound = await handleGatewayCapability('tools.call', CALLER, { name: 'task_get', args: { id: 'no-such-task' } }, 'devbox', deps());
      expect(bound).toMatchObject({ ok: false, opStatus: 404, error: { code: 'internal' } });
      // A server fault keeps its number too; the relay log tells the two apart (isOpAnswerStatus).
      const down = await handleGatewayCapability('tools.call', CALLER, { name: 'task_get', args: { id: 'any' } }, 'devbox', deps());
      expect(down).toMatchObject({ ok: false, opStatus: 503 });
      // The wire error never carries it: older CLIs read the same reply as before.
      if (!viaApi.ok) expect(Object.keys(viaApi.error)).not.toContain('opStatus');
    } finally { fetcher.mockRestore(); }
  });

  it('refuses a remote-denied (destructive) op with a local-CLI pointer', async () => {
    const r = await handleGatewayCapability(
      'tools.call', CALLER, { name: 'task_delete', args: { id: 'x' } }, 'devbox', deps(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('bad_request');
    expect(r.error.message).toBe('task_delete is local-only because it is destructive. Run it from a session on the Walnut host with `walnut tools call`.');
    expect(r.error.message).not.toMatch(/[\u2013\u2014]/);
  });

  it('rejects a missing/non-string name and non-object args', async () => {
    const noName = await handleGatewayCapability('tools.call', CALLER, {}, 'devbox', deps());
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.error.code).toBe('bad_request');

    const badArgs = await handleGatewayCapability(
      'tools.call', CALLER, { name: 'task_list', args: [1, 2] }, 'devbox', deps(),
    );
    expect(badArgs.ok).toBe(false);
    if (!badArgs.ok) expect(badArgs.error.code).toBe('bad_request');
  });

  it('unknown op → bad_request pointing at `walnut tools list`', async () => {
    const r = await handleGatewayCapability(
      'tools.call', CALLER, { name: 'nope_not_real' }, 'devbox', deps(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('bad_request');
    expect(r.error.message).toContain('walnut tools list');
  });

  it('writes consume their own rate budget; the cap trips with retryAfterMs and a readable detail', async () => {
    let t = 1_000_000;
    const throttle = new PeerThrottle(() => t);
    const d = deps(throttle);
    // Burn the whole window budget with admitted writes.
    for (let i = 0; i < GATEWAY_WRITE_MAX_PER_WINDOW; i++) {
      expect(throttle.admitWrite(CALLER).allowed).toBe(true);
      t += 10;
    }
    // The next write-op call must be throttled BEFORE any execution attempt.
    const r = await handleGatewayCapability(
      'tools.call', CALLER, { name: 'task_create', args: { title: 'x' } }, 'devbox', d,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('throttled');
    expect(typeof r.error.retryAfterMs).toBe('number');
    // The shim prints `detail` on stdout: a caller reading only stdout used to
    // see a bare {"retryAfterMs"} and no sentence (2026-10-02).
    const detail = r.error.detail as { outcome: string; next: string };
    expect(detail.outcome).toContain(`${GATEWAY_WRITE_MAX_PER_WINDOW} writes in the last minute`);
    expect(detail.outcome).toContain('task_create not run');
    expect(detail.next).toMatch(/Wait \d+s before the next write/);
    expect(detail.next).toContain('task_update_bulk');
  });

  it('a busy host_exec its host\'s gateway asks again is not charged again; its first ask, and other ops, are', async () => {
    // The gateway asks a busy host_exec again every few seconds while the call has time
    // (gateway-core.ts busyRelayAgainMs) and marks each ask `busyAgain`: one call, one write.
    let t = 5_000_000;
    const throttle = new PeerThrottle(() => t);
    const d = deps(throttle);
    // Anything not mocked meets a closed port, never a real server.
    const prevBase = process.env.OPEN_WALNUT_API_URL;
    process.env.OPEN_WALNUT_API_URL = 'http://127.0.0.1:1';
    const busy = () => new Response(JSON.stringify({ error: 'This task already runs 4 commands on other hosts', code: 'busy' }), { status: 429 });
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const call = (name: string, args: Record<string, unknown>, busyAgain?: number) =>
      handleGatewayCapability('tools.call', CALLER, { name, args }, 'devbox', d, busyAgain === undefined ? undefined : { busyAgain });
    try {
      for (let i = 0; i < GATEWAY_WRITE_MAX_PER_WINDOW - 1; i++) { expect(throttle.admitWrite(CALLER).allowed).toBe(true); t += 10; }
      // The first ask pays the last write left, though it was refused.
      fetcher.mockResolvedValueOnce(busy());
      const first = await call('host_exec', { host: 'macbox', command: 'true' });
      expect(!first.ok && first.error.message).toMatch(/^Walnut API error \(busy\): /);
      expect(throttle.admitWrite(CALLER).allowed).toBe(false);
      // The asks again run at a full budget, and are refused by the server, not the throttle.
      for (const n of [1, 2, 3]) {
        fetcher.mockResolvedValueOnce(busy());
        const again = await call('host_exec', { host: 'macbox', command: 'true' }, n);
        expect(!again.ok && again.error.code, String(n)).toBe('internal');
        expect(!again.ok && again.error.message, String(n)).toMatch(/^Walnut API error \(busy\): /);
      }
      expect(fetcher).toHaveBeenCalledTimes(4);
      // No mark, a mark of 0, or another op's mark: charged as ever, so throttled here.
      for (const [name, n] of [['host_exec', undefined], ['host_exec', 0], ['host_http', 1], ['task_create', 1]] as const) {
        const r = await call(name, name === 'task_create' ? { title: 'x' } : { host: 'macbox', url: 'https://example.com/', command: 'true' }, n);
        expect(!r.ok && r.error.code, `${name} ${String(n)}`).toBe('throttled');
      }
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      fetcher.mockRestore();
      if (prevBase === undefined) delete process.env.OPEN_WALNUT_API_URL;
      else process.env.OPEN_WALNUT_API_URL = prevBase;
    }
  });

  it('bookkeeping writes do not spend the peer-send budget, and sends do not spend the write budget', () => {
    let t = 3_000_000;
    const throttle = new PeerThrottle(() => t);
    for (let i = 0; i < GATEWAY_WRITE_MAX_PER_WINDOW; i++) { expect(throttle.admitWrite(CALLER).allowed).toBe(true); t += 10; }
    expect(throttle.admitWrite(CALLER).allowed).toBe(false);
    expect(throttle.admit(CALLER, 'target', 'hello').allowed).toBe(true);
    for (let i = 1; i < PEER_SEND_MAX_PER_WINDOW; i++) { expect(throttle.admit(CALLER, 'target', `m${i}`).allowed).toBe(true); t += 10; }
    expect(throttle.admit(CALLER, 'target', 'one more').allowed).toBe(false);
    t += GATEWAY_WRITE_WINDOW_MS;
    expect(throttle.admitWrite(CALLER).allowed).toBe(true);
  });

  it('reads never touch the throttle (readonly op passes policy at full budget burn)', async () => {
    let t = 2_000_000;
    const throttle = new PeerThrottle(() => t);
    for (let i = 0; i < GATEWAY_WRITE_MAX_PER_WINDOW; i++) { throttle.admitWrite(CALLER); t += 10; }
    // walnut_status is readonly → the gate lets it through to EXECUTION, which
    // must surface as `internal` (executor transport error), never `throttled`.
    // Point the executor at a closed local port so the call cannot reach the
    // developer's real server on :3456 and cannot touch the network.
    const prevBase = process.env.OPEN_WALNUT_API_URL;
    process.env.OPEN_WALNUT_API_URL = 'http://127.0.0.1:1';
    try {
      const r = await handleGatewayCapability(
        'tools.call', CALLER, { name: 'walnut_status' }, 'devbox', deps(throttle),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('internal');
    } finally {
      if (prevBase === undefined) delete process.env.OPEN_WALNUT_API_URL;
      else process.env.OPEN_WALNUT_API_URL = prevBase;
    }
  });

  it('cloud replica refuses all gateway capabilities (tools included)', async () => {
    const d = { ...deps(), cloudMode: true };
    const r = await handleGatewayCapability('tools.list', CALLER, {}, 'devbox', d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unsupported_replica');
  });
});
