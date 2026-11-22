/**
 * tools-list-held-v1, the server side (capability-router.ts handleToolsList): a schemas
 * tools.list names its catalog by a hash, and a daemon that holds that catalog (`have`)
 * gets only the hash back (`sameAs`), not the ~130 KB catalog.
 *
 * 2026-11-14: about 20 sessions starting at once on a host that had just reconnected each
 * got the whole catalog, 2.6 MB up one session link in 10 s, and the relay ended it.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleGatewayCapability, catalogHashOf, type CapabilityRouterDeps } from '../../../src/core/peers/capability-router.js';
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js';

const CALLER = 'a1b2c3d4-1111-2222-3333-444455556666';
const AREA_CALLER = 'a1b2c3d4-9999-2222-3333-444455556666';

// One caller works in a router area, which sees only that area's ops.
vi.mock('../../../src/core/router/gateway-policy.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/router/gateway-policy.js')>();
  return {
    ...real,
    areaOpsForCaller: async (sid: string) => (sid === AREA_CALLER ? new Set(['task_get', 'task_list']) : real.areaOpsForCaller(sid)),
  };
});

function deps(more: Partial<CapabilityRouterDeps> = {}): CapabilityRouterDeps {
  return { throttle: new PeerThrottle(), cloudMode: false, ...more };
}

async function list(callerSid: string, payload: Record<string, unknown>, host = 'devbox'): Promise<Record<string, unknown>> {
  const r = await handleGatewayCapability('tools.list', callerSid, payload, host, deps());
  expect(r.ok).toBe(true);
  return r.ok ? r.result : {};
}

describe('tools.list with schemas names its catalog by a hash (tools-list-held-v1)', () => {
  it('the hash is the catalog\'s own: the same on every call, and 16 hex characters of its sha256', async () => {
    const a = await list(CALLER, { schemas: true });
    const b = await list(CALLER, { schemas: true });
    expect(a.catalogHash).toMatch(/^[0-9a-f]{16}$/);
    expect(b.catalogHash).toBe(a.catalogHash);
    expect(catalogHashOf(a.ops as unknown[])).toBe(a.catalogHash);
    expect((a.ops as unknown[]).length).toBeGreaterThan(20);
  });

  it('a daemon holding the caller\'s catalog gets only the hash; one holding others gets it all', async () => {
    const full = await list(CALLER, { schemas: true });
    const hash = full.catalogHash as string;
    expect(await list(CALLER, { schemas: true, have: ['0123456789abcdef', hash] })).toEqual({ sameAs: hash });
    const miss = await list(CALLER, { schemas: true, have: ['0123456789abcdef'] });
    expect(miss).toEqual(full);
    // Anything but a list of hashes is no `have` at all.
    expect(await list(CALLER, { schemas: true, have: hash })).toEqual(full);
    // The plain list (the `walnut` CLI's) is unchanged: no hash, never `sameAs`.
    const plain = await list(CALLER, { have: [hash] });
    expect(plain.catalogHash).toBeUndefined();
    expect(plain.sameAs).toBeUndefined();
    expect(Array.isArray(plain.ops)).toBe(true);
  });

  it('another caller\'s catalog (a router area, another host) has another hash, and is never answered by this one', async () => {
    const mine = await list(CALLER, { schemas: true });
    const area = await list(AREA_CALLER, { schemas: true });
    expect((area.ops as Array<{ name: string }>).map((o) => o.name).sort()).toEqual(['task_get', 'task_list']);
    expect(area.catalogHash).not.toBe(mine.catalogHash);
    // A daemon that holds only the other caller's catalog gets this one in full.
    expect(await list(AREA_CALLER, { schemas: true, have: [mine.catalogHash] })).toEqual(area);
    // The same caller on this Mac sees the host-local ops too: another catalog.
    const local = await list(CALLER, { schemas: true }, '__local__');
    expect(local.catalogHash).not.toBe(mine.catalogHash);
  });
});

describe('a schemas tools.list read while the plugins load says it is partial', () => {
  // 2026-11-22 09:49: sessions resumed by a restart read their catalog before three plugins were
  // loaded; the list had every schema, so their MCP servers took it as whole and kept it.
  it('is marked partial, carries no hash for a daemon to hold, and never answers sameAs', async () => {
    const whole = await list(CALLER, { schemas: true });
    const r = await handleGatewayCapability('tools.list', CALLER, { schemas: true, have: [whole.catalogHash] }, 'devbox', deps({ pluginsLoading: async () => true }));
    expect(r.ok).toBe(true);
    const partial = r.ok ? r.result : {};
    expect(partial.partial).toBe(true);
    expect(partial.catalogHash).toBeUndefined();
    expect(partial.sameAs).toBeUndefined();
    expect((partial.ops as unknown[]).length).toBe((whole.ops as unknown[]).length);
    // Settled: the whole list as before, with its hash.
    const after = await handleGatewayCapability('tools.list', CALLER, { schemas: true }, 'devbox', deps({ pluginsLoading: async () => false }));
    expect(after.ok && after.result.partial).toBeFalsy();
    expect(after.ok && after.result.catalogHash).toBe(whole.catalogHash);
  });

  it('by default waits about 2 s for a walk still under way, then answers partial', async () => {
    const { registry } = await import('../../../src/core/integration-registry.js');
    const { TOOLS_LIST_PLUGIN_WAIT_MS } = await import('../../../src/core/peers/capability-router.js');
    expect(TOOLS_LIST_PLUGIN_WAIT_MS).toBeLessThanOrEqual(2_000);
    registry.beginLoading();
    try {
      const started = Date.now();
      const r = await list(CALLER, { schemas: true });
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(TOOLS_LIST_PLUGIN_WAIT_MS - 50);
      expect(took).toBeLessThan(TOOLS_LIST_PLUGIN_WAIT_MS + 1_500);
      expect(r.partial).toBe(true);
      expect(r.catalogHash).toBeUndefined();
    } finally { registry.endLoading(); }
  });

  it('by default waits for a plugin walk that ends soon, then answers the whole list', async () => {
    const { registry } = await import('../../../src/core/integration-registry.js');
    registry.beginLoading();
    expect(registry.isChanging()).toBe(true);
    setTimeout(() => registry.endLoading(), 50);
    const started = Date.now();
    const r = await list(CALLER, { schemas: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(r.partial).toBeUndefined();
    expect(r.catalogHash).toMatch(/^[0-9a-f]{16}$/);
    expect(registry.isChanging()).toBe(false);
  });
});
