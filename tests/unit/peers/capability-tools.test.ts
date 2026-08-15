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

function deps(throttle = new PeerThrottle()): CapabilityRouterDeps {
  return {
    listSessions: async () => [],
    isEnvironmentSession: () => false,
    getQueue: async () => [],
    sendMessageToSession: async () => ({}),
    throttle,
    cloudMode: false,
  };
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
    const del = ops.find((o) => o.name === 'task_delete');
    expect(del?.remote).toBe('deny');
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

  it('unknown op → bad_request pointing at `wn tools list`', async () => {
    const r = await handleGatewayCapability(
      'tools.call', CALLER, { name: 'nope_not_real' }, 'devbox', deps(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('bad_request');
    expect(r.error.message).toContain('wn tools list');
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
    // task_list is readonly → the gate lets it through to execution; against a
    // dead server that surfaces as `internal` (executor error), NOT `throttled`.
    const r = await handleGatewayCapability(
      'tools.call', CALLER, { name: 'walnut_status' }, 'devbox', deps(throttle),
    );
    if (!r.ok) expect(r.error.code).not.toBe('throttled');
  });

  it('cloud replica refuses all gateway capabilities (tools included)', async () => {
    const d = { ...deps(), cloudMode: true };
    const r = await handleGatewayCapability('tools.list', CALLER, {}, 'devbox', d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unsupported_replica');
  });
});
