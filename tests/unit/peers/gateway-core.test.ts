/**
 * Unit test: gateway-core — pure protocol logic for the agent gateway.
 *
 * Covers (plan §8):
 * - parseGatewayLine: oversized line, bad JSON, non-object, op whitelist,
 *   version check, sid/args validation, happy paths
 * - resolveCallerSid: direct hit / one alias hop / chain / broken chain → null
 * - gatewayHubTimeoutMs: default + WALNUT_GATEWAY_TIMEOUT_MS override
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  parseGatewayLine,
  resolveCallerSid,
  gatewayHubTimeoutMs,
  GATEWAY_HUB_TIMEOUT_MS,
  GATEWAY_MAX_LINE_BYTES,
  GATEWAY_SOCKET_FILENAME,
  GATEWAY_OPS,
} from '../../../src/providers/gateway-core.js';
import { LETTER_HTML_MAX_BYTES } from '../../../src/core/human-inbox/types.js';
import { GATEWAY_INLINE_ARGS_MAX_BYTES } from '../../../src/providers/tool-args-source.js';

function expectError(line: string, code: string): void {
  const res = parseGatewayLine(line);
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error.code).toBe(code);
}

describe('parseGatewayLine', () => {
  it('parses a valid peers.list request', () => {
    const res = parseGatewayLine('{"v":1,"op":"peers.list","sid":"abc-123","args":{}}');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.op).toBe('peers.list');
      expect(res.request.sid).toBe('abc-123');
      expect(res.request.args).toEqual({});
    }
  });

  it('parses a valid peers.send request with args', () => {
    const res = parseGatewayLine(
      '{"v":1,"op":"peers.send","sid":"abc","args":{"target":"f00d","text":"hi"}}',
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.request.args).toEqual({ target: 'f00d', text: 'hi' });
  });

  it('defaults missing args to an empty object', () => {
    const res = parseGatewayLine('{"v":1,"op":"peers.list","sid":"abc"}');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.request.args).toEqual({});
  });

  it('rejects a line over the cap', () => {
    const filler = 'x'.repeat(GATEWAY_MAX_LINE_BYTES + 1);
    expectError(`{"v":1,"op":"peers.send","sid":"abc","args":{"text":"${filler}"}}`, 'bad_request');
  });

  /**
   * RATCHET. One `walnut tools call human_inbox_send` is ONE line, so this cap
   * WAS the ceiling on a letter body: it started at 256KB, which is why the letter
   * cap was 200KB. It now bounds the INLINE lane only — a payload over
   * GATEWAY_INLINE_ARGS_MAX_BYTES travels as a path the hub range-reads in batches,
   * which is what let the letter cap grow to 100MB. So the invariant is against the
   * inline threshold, with envelope headroom: lowering the line under it silently
   * breaks ordinary calls on every host, and the failure lands in the daemon, far
   * from here.
   */
  it('leaves room for the biggest payload that still rides one line', () => {
    expect(GATEWAY_MAX_LINE_BYTES).toBeGreaterThan(GATEWAY_INLINE_ARGS_MAX_BYTES);
    // The batched lane exists precisely because the letter cap outgrew this line.
    expect(LETTER_HTML_MAX_BYTES).toBeGreaterThan(GATEWAY_MAX_LINE_BYTES);
  });

  it('accepts a line just under the cap', () => {
    const prefix = '{"v":1,"op":"peers.list","sid":"abc","args":{"pad":"';
    const suffix = '"}}';
    const filler = 'x'.repeat(GATEWAY_MAX_LINE_BYTES - prefix.length - suffix.length);
    const res = parseGatewayLine(prefix + filler + suffix);
    expect(res.ok).toBe(true);
  });

  it('measures the cap in bytes, not characters (multibyte payload)', () => {
    // 3 bytes per char in UTF-8 — char count is well under the cap, bytes are not.
    const filler = '世'.repeat(Math.ceil(GATEWAY_MAX_LINE_BYTES / 3) + 16);
    expectError(`{"v":1,"op":"peers.send","sid":"abc","args":{"text":"${filler}"}}`, 'bad_request');
  });

  it('rejects invalid JSON', () => {
    expectError('{not json', 'bad_request');
  });

  it('rejects non-object JSON values', () => {
    expectError('"just a string"', 'bad_request');
    expectError('[1,2,3]', 'bad_request');
    expectError('null', 'bad_request');
  });

  it('rejects a wrong or missing version with unsupported_version', () => {
    expectError('{"v":2,"op":"peers.list","sid":"abc"}', 'unsupported_version');
    expectError('{"op":"peers.list","sid":"abc"}', 'unsupported_version');
    expectError('{"v":"1","op":"peers.list","sid":"abc"}', 'unsupported_version');
  });

  it('rejects ops outside the whitelist', () => {
    expectError('{"v":1,"op":"peers.kill","sid":"abc"}', 'bad_request');
    expectError('{"v":1,"op":"notes.list","sid":"abc"}', 'bad_request');
    expectError('{"v":1,"sid":"abc"}', 'bad_request');
    expectError('{"v":1,"op":42,"sid":"abc"}', 'bad_request');
  });

  it('accepts exactly the whitelisted ops', () => {
    for (const op of GATEWAY_OPS) {
      const res = parseGatewayLine(JSON.stringify({ v: 1, op, sid: 'abc' }));
      expect(res.ok).toBe(true);
    }
  });

  it('rejects a missing or empty sid', () => {
    expectError('{"v":1,"op":"peers.list"}', 'bad_request');
    expectError('{"v":1,"op":"peers.list","sid":""}', 'bad_request');
    expectError('{"v":1,"op":"peers.list","sid":7}', 'bad_request');
  });

  it('rejects non-object args', () => {
    expectError('{"v":1,"op":"peers.list","sid":"abc","args":[1]}', 'bad_request');
    expectError('{"v":1,"op":"peers.list","sid":"abc","args":"x"}', 'bad_request');
  });
});

describe('resolveCallerSid', () => {
  const sessions = (...sids: string[]) => new Set(sids);

  it('resolves a direct hit without touching aliases', () => {
    expect(resolveCallerSid('live-1', sessions('live-1'), new Map())).toBe('live-1');
  });

  it('follows one alias hop (tmp id → renamed sid)', () => {
    const aliases = new Map([['tmp-1', 'live-1']]);
    expect(resolveCallerSid('tmp-1', sessions('live-1'), aliases)).toBe('live-1');
  });

  it('follows a multi-hop chain', () => {
    const aliases = new Map([
      ['tmp-1', 'mid-1'],
      ['mid-1', 'mid-2'],
      ['mid-2', 'live-1'],
    ]);
    expect(resolveCallerSid('tmp-1', sessions('live-1'), aliases)).toBe('live-1');
  });

  it('returns null on a broken chain (final sid not in sessions)', () => {
    const aliases = new Map([['tmp-1', 'gone-1']]);
    expect(resolveCallerSid('tmp-1', sessions('live-1'), aliases)).toBeNull();
  });

  it('returns null for a completely unknown sid', () => {
    expect(resolveCallerSid('nope', sessions('live-1'), new Map())).toBeNull();
  });

  it('terminates on a cyclic alias table (hop cap)', () => {
    const aliases = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(resolveCallerSid('a', sessions('live-1'), aliases)).toBeNull();
  });

  it('resolves through a chain up to the 5-hop cap', () => {
    const aliases = new Map([
      ['h0', 'h1'],
      ['h1', 'h2'],
      ['h2', 'h3'],
      ['h3', 'h4'],
      ['h4', 'h5'],
    ]);
    expect(resolveCallerSid('h0', sessions('h5'), aliases)).toBe('h5');
  });

  it('returns null when the chain exceeds the hop cap', () => {
    const aliases = new Map([
      ['h0', 'h1'],
      ['h1', 'h2'],
      ['h2', 'h3'],
      ['h3', 'h4'],
      ['h4', 'h5'],
      ['h5', 'h6'],
    ]);
    expect(resolveCallerSid('h0', sessions('h6'), aliases)).toBeNull();
  });
});

describe('gatewayHubTimeoutMs', () => {
  afterEach(() => {
    delete process.env.WALNUT_GATEWAY_TIMEOUT_MS;
  });

  it('defaults to GATEWAY_HUB_TIMEOUT_MS', () => {
    delete process.env.WALNUT_GATEWAY_TIMEOUT_MS;
    expect(gatewayHubTimeoutMs()).toBe(GATEWAY_HUB_TIMEOUT_MS);
    expect(GATEWAY_HUB_TIMEOUT_MS).toBe(20_000);
  });

  it('honors WALNUT_GATEWAY_TIMEOUT_MS override', () => {
    process.env.WALNUT_GATEWAY_TIMEOUT_MS = '500';
    expect(gatewayHubTimeoutMs()).toBe(500);
  });

  it('ignores invalid overrides', () => {
    process.env.WALNUT_GATEWAY_TIMEOUT_MS = 'soon';
    expect(gatewayHubTimeoutMs()).toBe(GATEWAY_HUB_TIMEOUT_MS);
    process.env.WALNUT_GATEWAY_TIMEOUT_MS = '-1';
    expect(gatewayHubTimeoutMs()).toBe(GATEWAY_HUB_TIMEOUT_MS);
  });
});

describe('constants', () => {
  it('exports the socket filename', () => {
    expect(GATEWAY_SOCKET_FILENAME).toBe('agent-gateway.sock');
  });
});

// 2026-11-03: a deploy and an SSH link that kept breaking failed every `walnut` call on a
// host for 8 minutes. A call now has a time budget its CLI names, and a relay may go again.
import {
  gatewayCallPlan,
  gatewayIdentifyPlan,
  gatewayWaitMs,
  GATEWAY_IDENTIFY_WAIT_MS,
  relayAttemptMs,
  relayMayResendTo,
  helloReadOps,
  HELLO_READ_OPS_MAX,
  GATEWAY_MIN_RELAY_MS,
  GATEWAY_WAIT_MAX_MS,
} from '../../../src/providers/gateway-core.js';

describe('a call\'s time budget and resends', () => {
  it('parses the CLI\'s waitMs (0 too: no wait, on purpose), and leaves it out when it is no number of ms', () => {
    const base = { v: 1, op: 'tools.call', sid: 's', args: { name: 'walnut_status' } };
    const ok = parseGatewayLine(JSON.stringify({ ...base, waitMs: 90000 }));
    expect(ok.ok && ok.request.waitMs).toBe(90000);
    const none = parseGatewayLine(JSON.stringify({ ...base, waitMs: 0 }));
    expect(none.ok && none.request.waitMs).toBe(0);
    for (const bad of [-5, 'soon', null]) {
      const res = parseGatewayLine(JSON.stringify({ ...base, waitMs: bad }));
      expect(res.ok && 'waitMs' in res.request).toBe(false);
    }
  });

  it('a caller that names no waitMs is answered as before; a newer CLI gets what it asks, clamped, and may wait', () => {
    expect(gatewayCallPlan(undefined, 20_000, 1_000)).toEqual({ deadline: 21_000, waits: false });
    expect(gatewayCallPlan(90_000, 20_000, 1_000)).toEqual({ deadline: 91_000, waits: true });
    expect(gatewayCallPlan(10 * 60_000, 20_000, 0)).toEqual({ deadline: GATEWAY_WAIT_MAX_MS, waits: true });
    expect(gatewayCallPlan(1, 20_000, 0)).toEqual({ deadline: GATEWAY_MIN_RELAY_MS, waits: true });
    // 0: the caller chose not to wait at all.
    expect(gatewayCallPlan(0, 20_000, 1_000)).toEqual({ deadline: 21_000, waits: false, never: true });
    // The one clamp (the builder and the host call entry use it too).
    for (const [asked, granted] of [[1, GATEWAY_MIN_RELAY_MS], [12_345.7, 12_345], [10 ** 9, GATEWAY_WAIT_MAX_MS], [0, undefined], [-1, undefined], [Number.NaN, undefined], ['9000', undefined]] as const) {
      expect(gatewayWaitMs(asked), String(asked)).toBe(granted);
    }
  });

  // 2026-11-23: a task_create failed 13 s after a deploy restarted the server, its socket not bound yet.
  it('a call that named no wait waits a moment for a server that is starting, its relay keeping the whole hub timeout', () => {
    const hub = 20_000;
    const plan = gatewayCallPlan(undefined, hub, 1_000);
    const first = gatewayIdentifyPlan(plan, hub, GATEWAY_IDENTIFY_WAIT_MS, 1_200)!;
    expect(first).toEqual({ plan: { deadline: 1_000 + GATEWAY_IDENTIFY_WAIT_MS + hub, waits: false, identifyBy: 1_000 + GATEWAY_IDENTIFY_WAIT_MS }, atMostMs: GATEWAY_IDENTIFY_WAIT_MS - 200 });
    // Its resend keeps the window it had (from its arrival), and never moves the end again.
    expect(gatewayIdentifyPlan(first.plan, hub, GATEWAY_IDENTIFY_WAIT_MS, 5_000)).toEqual({ plan: first.plan, atMostMs: 1_000 + GATEWAY_IDENTIFY_WAIT_MS - 5_000 });
    expect(gatewayIdentifyPlan(first.plan, hub, GATEWAY_IDENTIFY_WAIT_MS, 1_000 + GATEWAY_IDENTIFY_WAIT_MS)).toBeNull();
    // A relay at the window's end still has the hub timeout, and the answer comes inside an older client's 30 s.
    expect(relayAttemptMs(first.plan.deadline, first.plan.identifyBy!, hub)).toBe(hub);
    expect(first.plan.deadline - 1_000).toBeLessThan(30_000);
    // Never for a call that may wait anyway, or one that chose not to.
    expect(gatewayIdentifyPlan(gatewayCallPlan(60_000, hub, 0), hub, GATEWAY_IDENTIFY_WAIT_MS, 0)).toBeNull();
    expect(gatewayIdentifyPlan(gatewayCallPlan(0, hub, 0), hub, GATEWAY_IDENTIFY_WAIT_MS, 0)).toBeNull();
    // A hub timeout shorter than a relay's least time still leaves the wait room to end.
    const small = gatewayIdentifyPlan(gatewayCallPlan(undefined, 1_000, 0), 1_000, GATEWAY_IDENTIFY_WAIT_MS, 0)!;
    expect(small.plan.deadline - GATEWAY_MIN_RELAY_MS).toBeGreaterThanOrEqual(small.atMostMs);
  });

  it('a call that may change something goes again only to the server run it went to', () => {
    expect(relayMayResendTo({ run: 'r1', readable: false }, 'r1')).toBe(true);
    expect(relayMayResendTo({ run: 'r1', readable: false }, 'r2')).toBe(false);
    expect(relayMayResendTo({ run: 'r1', readable: false }, undefined)).toBe(false);
    // An older server names no run: it never sees a call twice.
    expect(relayMayResendTo({ run: undefined, readable: false }, undefined)).toBe(false);
    expect(relayMayResendTo({ run: '', readable: false }, '')).toBe(false);
    // A read the host could answer from its copy may go anywhere.
    expect(relayMayResendTo({ run: 'r1', readable: true }, 'r2')).toBe(true);
    expect(relayMayResendTo({ run: undefined, readable: true }, undefined)).toBe(true);
    // So may one the target server names read-only in its hello, to any run of it.
    expect(relayMayResendTo({ run: 'r1', readable: false }, 'r2', true)).toBe(true);
    expect(relayMayResendTo({ run: 'r1', readable: false }, 'r2', false)).toBe(false);
  });

  it('a hello\'s read-only list: names only, bounded, and anything else is no list', () => {
    expect(helloReadOps(['host_list', 'task_get'])).toEqual(new Set(['host_list', 'task_get']));
    for (const none of [undefined, null, 'host_list', {}, [], [42, null], ['has space'], ['x'.repeat(81)]]) {
      expect(helloReadOps(none)).toBeUndefined();
    }
    expect(helloReadOps(['host_list', 7, 'bad name', 'plugin:op'])).toEqual(new Set(['host_list', 'plugin:op']));
    const many = Array.from({ length: HELLO_READ_OPS_MAX + 50 }, (_, i) => `op_${i}`);
    expect(helloReadOps(many)?.size).toBe(HELLO_READ_OPS_MAX);
  });

  it('an attempt waits the hub timeout, or what is left of the call', () => {
    expect(relayAttemptMs(100_000, 0, 20_000)).toBe(20_000);
    expect(relayAttemptMs(100_000, 92_000, 20_000)).toBe(8_000);
    expect(relayAttemptMs(100_000, 120_000, 20_000)).toBe(0);
  });
});

// 2026-11-04: 12 host_exec at once from clouddev, 4 refused busy after a 4 s wait though each
// run took 2 s. A busy refusal ran nothing, so the host's gateway asks again while the call has time.
import {
  busyRelayAgainMs,
  busyRelayMinLeftMs,
  isBusyAgainOp,
  isBusyRefusal,
  GATEWAY_BUSY_AGAIN_MS,
} from '../../../src/providers/gateway-core.js';

const BUSY = 'Walnut API error (busy): This task already runs 4 commands on other hosts, and no slot came free in time for this call; nothing ran.';

describe('a busy host_exec is asked again', () => {
  it('only the server\'s busy refusal of host_exec, by its code prefix', () => {
    expect(isBusyRefusal('host_exec', BUSY)).toBe(true);
    // An older server's words: the code is what counts, not the sentence.
    expect(isBusyRefusal('host_exec', 'Walnut API error (busy): This task already runs 4 commands on other hosts (waited 4 s for one to end)')).toBe(true);
    for (const text of [
      'Walnut API error (host_offline): Walnut lost devbox while it answered. It may have started there as job hx-1',
      'Walnut API error (busy_x): no',
      'Walnut API error (429): busy',
      ' Walnut API error (busy): leading space is not the op executor\'s',
      'primary server timed out',
      undefined, null, 42,
    ]) expect(isBusyRefusal('host_exec', text), String(text)).toBe(false);
    // Other ops answer busy at once (no wait at the server), or never: not asked again.
    for (const op of ['host_copy', 'host_http', 'host_mcp_call', 'host_mcp_tools', 'task_send', '', undefined, 7]) {
      expect(isBusyRefusal(op, BUSY), String(op)).toBe(false);
      expect(isBusyAgainOp(op), String(op)).toBe(false);
    }
    expect(isBusyAgainOp('host_exec')).toBe(true);
  });

  it('waits a second, while a resend still has a whole hub timeout of the call', () => {
    const hub = 20_000;
    expect(busyRelayMinLeftMs(hub)).toBe(hub);
    expect(busyRelayMinLeftMs(1_500)).toBe(GATEWAY_MIN_RELAY_MS);
    // A newer CLI's 90 s call refused 5 s in: asked again in a second.
    expect(busyRelayAgainMs('host_exec', BUSY, 90_000, 5_000, hub)).toBe(GATEWAY_BUSY_AGAIN_MS);
    // Exactly enough left after the wait, and one ms short.
    expect(busyRelayAgainMs('host_exec', BUSY, 100_000, 100_000 - hub - GATEWAY_BUSY_AGAIN_MS, hub)).toBe(GATEWAY_BUSY_AGAIN_MS);
    expect(busyRelayAgainMs('host_exec', BUSY, 100_000, 100_000 - hub - GATEWAY_BUSY_AGAIN_MS + 1, hub)).toBeNull();
    // A caller that named no waitMs has one hub timeout in all: its refusal is handed back as before.
    expect(busyRelayAgainMs('host_exec', BUSY, 20_000, 4_000, hub)).toBeNull();
    // Past the deadline, and anything that is not a busy host_exec.
    expect(busyRelayAgainMs('host_exec', BUSY, 10_000, 20_000, hub)).toBeNull();
    expect(busyRelayAgainMs('host_copy', BUSY, 90_000, 5_000, hub)).toBeNull();
    expect(busyRelayAgainMs('host_exec', 'Walnut API error (host_offline): x', 90_000, 5_000, hub)).toBeNull();
  });
});
