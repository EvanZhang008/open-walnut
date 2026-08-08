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

  it('rejects a line over the 256KB cap', () => {
    const filler = 'x'.repeat(GATEWAY_MAX_LINE_BYTES + 1);
    expectError(`{"v":1,"op":"peers.send","sid":"abc","args":{"text":"${filler}"}}`, 'bad_request');
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
