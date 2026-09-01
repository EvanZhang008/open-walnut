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
import { describe, it, expect } from 'vitest';
import { handleGatewayCapability, type CapabilityRouterDeps } from '../../../src/core/peers/capability-router.js';
import { PeerThrottle, PEER_SEND_MAX_PER_WINDOW } from '../../../src/core/peers/peer-throttle.js';

const CALLER = 'a1b2c3d4-1111-2222-3333-444455556666';

/** The router's whole dependency surface after the peers fold: budget + posture. */
function deps(throttle = new PeerThrottle()): CapabilityRouterDeps {
  return { throttle, cloudMode: false };
}

describe('gateway tools.list', () => {
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
    expect(names).toContain('session_list');
    expect(names).toContain('session_send');
    expect(names).toContain('session_start');
    expect(names).toContain('request_get');
    expect(ops.find((o) => o.name === 'request_get')?.readonly).toBe(true);
    expect(ops.find((o) => o.name === 'session_send')?.readonly).toBe(false);
    const del = ops.find((o) => o.name === 'task_delete');
    expect(del?.remote).toBe('deny');
  });

  it('every row carries an argument signature (remote `tools list` showed none)', async () => {
    const r = await handleGatewayCapability('tools.list', CALLER, {}, 'devbox', deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ops = r.result.ops as Array<{ name: string; signature?: string; params?: unknown }>;
    for (const op of ops) expect(op.signature, op.name).toBeTruthy();
    expect(ops.find((o) => o.name === 'note_read')?.signature).toBe('path?, id?');
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
  it('refuses a remote-denied (destructive) op with a local-CLI pointer', async () => {
    const r = await handleGatewayCapability(
      'tools.call', CALLER, { name: 'task_delete', args: { id: 'x' } }, 'devbox', deps(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('bad_request');
    expect(r.error.message).toContain('local-only');
    expect(r.error.message).toContain('walnut tools call');
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

  it('writes consume the shared rate budget; the cap trips with retryAfterMs', async () => {
    let t = 1_000_000;
    const throttle = new PeerThrottle(() => t);
    const d = deps(throttle);
    // Burn the whole window budget with admitted writes.
    for (let i = 0; i < PEER_SEND_MAX_PER_WINDOW; i++) {
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
  });

  it('reads never touch the throttle (readonly op passes policy at full budget burn)', async () => {
    let t = 2_000_000;
    const throttle = new PeerThrottle(() => t);
    for (let i = 0; i < PEER_SEND_MAX_PER_WINDOW; i++) { throttle.admitWrite(CALLER); t += 10; }
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
