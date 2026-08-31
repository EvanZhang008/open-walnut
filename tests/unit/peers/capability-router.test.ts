/**
 * Unit test: capability-router — hub-side agent-gateway dispatch.
 *
 * The router surface is now just the ops registry (tools.list / tools.call).
 * peers.list / peers.send were folded into registry ops (session_list /
 * session_send) whose semantics live in core/sessions/session-send-core.ts, so
 * what this file pins is the DISPATCH contract:
 *   - a cloud replica refuses every capability
 *   - an unknown capability is a bad_request naming what was asked
 *   - the two retired capabilities answer with a POINTER to the replacement
 *     (an old daemon must get a usable instruction, not a hang or a mystery)
 *   - a retired capability costs nothing: no throttle bucket, no execution
 *
 * tools.list / tools.call policy gates: tests/unit/peers/capability-tools.test.ts.
 * The peer-note wrapper: tests/unit/peers/peer-wrapper.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  handleGatewayCapability,
  type CapabilityRouterDeps,
} from '../../../src/core/peers/capability-router.js';
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js';
import { getOp } from '../../../src/ops/index.js';

const CALLER = 'a1b2c3d4-1111-2222-3333-444455556666';
const TARGET = 'f00dcafe-1111-2222-3333-444455556666';

/** Records every bucket key it is asked about and admits nothing. */
class RecordingThrottle extends PeerThrottle {
  keys: string[] = [];
  override admitWrite(key: string) {
    this.keys.push(key);
    return { allowed: false as const, retryAfterMs: 1 };
  }
  override admit(key: string) {
    this.keys.push(key);
    return { allowed: false as const, retryAfterMs: 1 };
  }
}

function makeDeps(over?: Partial<CapabilityRouterDeps>): {
  deps: CapabilityRouterDeps;
  throttle: RecordingThrottle;
} {
  const throttle = new RecordingThrottle();
  return { deps: { throttle, cloudMode: false, ...over }, throttle };
}

const RETIRED = ['peers.list', 'peers.send'] as const;

describe('capability routing', () => {
  it('rejects every capability on a cloud replica (unsupported_replica)', async () => {
    const { deps } = makeDeps({ cloudMode: true });
    for (const cap of ['tools.list', 'tools.call', 'peers.list', 'peers.send', 'notes.list']) {
      const res = await handleGatewayCapability(cap, CALLER, {}, 'devbox', deps);
      expect(res.ok, cap).toBe(false);
      if (!res.ok) expect(res.error.code, cap).toBe('unsupported_replica');
    }
  });

  it('rejects unknown capabilities with bad_request naming what was asked', async () => {
    const { deps } = makeDeps();
    const res = await handleGatewayCapability('notes.list', CALLER, {}, 'devbox', deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('bad_request');
    expect(res.error.message).toContain('unsupported capability');
    expect(res.error.message).toContain('notes.list');
  });
});

describe('retired peers capabilities', () => {
  it('peers.list answers bad_request pointing at `walnut tools call session_list`', async () => {
    const { deps } = makeDeps();
    const res = await handleGatewayCapability('peers.list', CALLER, {}, 'devbox', deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('bad_request');
    expect(res.error.message).toContain('peers.list was replaced');
    expect(res.error.message).toContain('walnut tools call session_list');
  });

  it('peers.send answers bad_request pointing at `walnut tools call session_send`', async () => {
    const { deps } = makeDeps();
    const res = await handleGatewayCapability(
      'peers.send', CALLER, { target: TARGET, text: 'build is ready' }, 'devbox', deps,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('bad_request');
    expect(res.error.message).toContain('peers.send was replaced');
    expect(res.error.message).toContain('walnut tools call session_send');
    // The pointer must name the fields the replacement op actually takes.
    expect(res.error.message).toContain('"to"');
    expect(res.error.message).toContain('"text"');
  });

  it('the ops named in both pointers really exist in the registry', () => {
    // A pointer to an op that was itself renamed is worse than no pointer.
    expect(getOp('session_list')).toBeDefined();
    expect(getOp('session_send')).toBeDefined();
  });

  it('a retired capability is refused before any budget or execution', async () => {
    const { deps, throttle } = makeDeps();
    for (const cap of RETIRED) {
      const res = await handleGatewayCapability(cap, CALLER, { target: TARGET, text: 'hi' }, 'devbox', deps);
      expect(res.ok, cap).toBe(false);
    }
    // No write budget consumed: the request never became a send.
    expect(throttle.keys).toEqual([]);
  });

  it('the retired branch does not depend on the payload being well formed', async () => {
    const { deps } = makeDeps();
    for (const payload of [undefined, {}, { target: '' }, { target: TARGET }, { text: 42 }]) {
      const res = await handleGatewayCapability('peers.send', CALLER, payload, 'devbox', deps);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain('peers.send was replaced');
    }
  });
});
