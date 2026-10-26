import { describe, expect, it } from 'vitest';
import {
  boundedJson, decodeFrame, encodeFrame, immutableJson, MAX_FRAME_BYTES,
  MAX_JSON_DEPTH, MAX_JSON_NODES,
} from '../../../src/core/feature-nodes/protocol.js';

const manifest = { protocolVersion: 1, type: 'manifest', capabilities: [{ id: 'catalog.page', version: 1 }] };
const result = { protocolVersion: 1, type: 'result', correlationId: 'call:1', generation: 'session:1', success: true, payload: null };

describe('feature node protocol', () => {
  it('accepts every read-only version one frame', () => {
    const frames = [manifest, result,
      { ...result, success: false, payload: undefined, code: 'offline' },
      { protocolVersion: 1, type: 'cancel', correlationId: 'call:1', generation: 'session:1' },
      { protocolVersion: 1, type: 'read', correlationId: 'call:1', generation: 'session:1',
        nodeId: 'node-a', accountId: 'account-a', capability: { id: 'catalog.page', version: 1 },
        fingerprint: 'catalog-v1', permissionVersion: 1, expiresAt: 1000, input: {} },
    ];
    for (const frame of frames) expect(decodeFrame(JSON.stringify(frame)).success).toBe(true);
  });

  it.each([
    { ...manifest, protocolVersion: 2 },
    { ...manifest, readOnly: true },
    { ...manifest, schema: {} },
    { ...manifest, capabilities: [{ id: 'catalog.page', version: 1, readOnly: true }] },
    { ...manifest, capabilities: [{ id: 'catalog.page', version: 1, schema: {} }] },
    { ...manifest, capabilities: [{ id: 'catalog.page', version: 1 }, { id: 'catalog.page', version: 1 }] },
    { ...manifest, capabilities: Array.from({ length: 65 }, (_, index) => ({ id: `cap-${index}`, version: 1 })) },
    { ...manifest, type: 'write' },
    { ...result, success: false, code: 'raw-exception' },
    { ...result, payload: undefined },
    { ...result, extra: 'field' },
  ])('fails closed on unsupported or forged frames %#', (frame) => {
    expect(decodeFrame(JSON.stringify(frame))).toEqual({ success: false, code: 'malformed' });
  });

  it('requires an explicit read input and allows a null payload', () => {
    const frame = { protocolVersion: 1, type: 'read', correlationId: 'call:1', generation: 'session:1',
      nodeId: 'node-a', accountId: 'account-a', capability: { id: 'catalog.page', version: 1 },
      fingerprint: 'catalog-v1', permissionVersion: 1, expiresAt: 1000 };
    expect(decodeFrame(JSON.stringify(frame))).toEqual({ success: false, code: 'malformed' });
    expect(decodeFrame(JSON.stringify({ ...frame, input: null })).success).toBe(true);
    expect(decodeFrame(JSON.stringify(result)).success).toBe(true);
  });

  it('bounds UTF8 before parsing and allows the exact frame byte boundary', () => {
    const empty = JSON.stringify({ ...result, payload: '' });
    const payload = 'x'.repeat(MAX_FRAME_BYTES - Buffer.byteLength(empty));
    const text = JSON.stringify({ ...result, payload });
    expect(Buffer.byteLength(text)).toBe(MAX_FRAME_BYTES);
    expect(decodeFrame(text).success).toBe(true);
    expect(decodeFrame(text.replace(payload, `${payload}x`))).toEqual({ success: false, code: 'malformed' });
    const unicode = JSON.stringify({ ...result, payload: '\u754c'.repeat(23_000) });
    expect(unicode.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(decodeFrame(unicode)).toEqual({ success: false, code: 'malformed' });
    expect(decodeFrame('{')).toEqual({ success: false, code: 'malformed' });
  });

  it('does not run getters or toJSON during inspection or encoding', () => {
    let called = 0;
    const getter = Object.defineProperty({}, 'content', { enumerable: true, get: () => { called++; return 'secret'; } });
    const formatter = { toJSON: () => { called++; return 'secret'; } };
    const array = Object.defineProperty([], '0', { enumerable: true, get: () => { called++; return 'secret'; } });
    for (const payload of [getter, formatter, array]) {
      expect(boundedJson(payload).success).toBe(false);
      expect(encodeFrame({ ...result, payload }).success).toBe(false);
    }
    expect(called).toBe(0);
  });

  it('rejects non-JSON objects, dangerous keys, holes and nonfinite data', () => {
    class RecordValue { content = 'value'; }
    const hidden = Object.defineProperty({}, 'hidden', { value: 'value' });
    const symbol = { [Symbol('key')]: 1 };
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const payload of [new RecordValue(), new Date(0), Infinity, NaN, undefined, 1n,
      () => {}, hidden, symbol, new Array(2), cycle,
      JSON.parse('{"__proto__":{}}'), { constructor: 'value' }, { prototype: 'value' }]) {
      expect(boundedJson(payload).success).toBe(false);
    }
  });

  it('bounds iterative depth and node count before schema validation', () => {
    const nested = (depth: number) => {
      let value: unknown = 0;
      for (let index = 0; index < depth; index++) value = { child: value };
      return value;
    };
    expect(boundedJson(nested(MAX_JSON_DEPTH)).success).toBe(true);
    expect(boundedJson(nested(MAX_JSON_DEPTH + 1)).success).toBe(false);
    expect(boundedJson(Array.from({ length: MAX_JSON_NODES - 1 }, () => 0)).success).toBe(true);
    expect(boundedJson(Array.from({ length: MAX_JSON_NODES }, () => 0)).success).toBe(false);
  });

  it('copies and freezes payloads without sharing caller data', () => {
    const input = { page: [{ name: '\u754c\u{1f680}' }], blank: null };
    const copied = immutableJson(input);
    expect(copied.success).toBe(true);
    if (!copied.success) return;
    input.page[0].name = 'changed';
    expect(copied.payload).toEqual({ page: [{ name: '\u754c\u{1f680}' }], blank: null });
    expect(Object.isFrozen(copied.payload)).toBe(true);
    expect(Object.isFrozen((copied.payload as typeof input).page[0])).toBe(true);
  });
});
