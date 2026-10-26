import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ContractRegistry, isAuthorized, readAuthority, type Authority, type ReadContract,
} from '../../../src/core/feature-nodes/contracts.js';
import { MAX_FRAME_BYTES } from '../../../src/core/feature-nodes/protocol.js';
import { authority, capability, fingerprint } from './fakes.js';

function definition(overrides: Partial<ReadContract> = {}): ReadContract {
  return {
    capability: { ...capability }, fingerprint,
    input: z.strictObject({ query: z.string() }),
    output: z.strictObject({ value: z.string() }), ...overrides,
  };
}

function installed(definitionOverrides: Partial<ReadContract> = {}) {
  const registry = new ContractRegistry();
  const unregister = registry.register(definition(definitionOverrides));
  return { registry, unregister, contract: registry.get(capability)! };
}

describe('feature node contracts', () => {
  it('keeps a frozen local contract independent of mutable registration identifiers', () => {
    const registry = new ContractRegistry();
    const source = definition();
    registry.register(source);
    const contract = registry.get(capability)!;
    expect(contract).toMatchObject({ capability, fingerprint, maxInputBytes: MAX_FRAME_BYTES, maxOutputBytes: MAX_FRAME_BYTES });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.capability)).toBe(true);
    (source.capability as { id: string }).id = 'changed';
    expect(registry.get(capability)).toBe(contract);
    expect(registry.get({ id: 'changed', version: 1 })).toBeUndefined();
  });

  it('separates capability versions and prevents duplicate registration', () => {
    const { registry, contract } = installed();
    expect(() => registry.register(definition())).toThrow('already registered');
    expect(registry.get({ ...capability, version: 2 })).toBeUndefined();
    registry.register(definition({ capability: { ...capability, version: 2 } }));
    expect(registry.get({ ...capability, version: 2 })).not.toBe(contract);
  });

  it('makes unregister idempotent without deleting a replacement contract', () => {
    const { registry, contract, unregister } = installed();
    unregister();
    expect(registry.isCurrent(contract)).toBe(false);
    expect(registry.get(capability)).toBeUndefined();
    registry.register(definition({ fingerprint: 'catalog-v2' }));
    const replacement = registry.get(capability)!;
    unregister();
    expect(registry.isCurrent(replacement)).toBe(true);
  });

  it.each([
    { capability: { id: 'bad id', version: 1 } },
    { capability: { ...capability, version: 0 } },
    { fingerprint: '' },
    { input: {} as z.ZodType },
    { output: { safeParse: () => ({ success: true }) } as unknown as z.ZodType },
  ])('rejects untrusted or malformed registration %#', (overrides) => {
    expect(() => new ContractRegistry().register(definition(overrides))).toThrow();
  });

  it.each([0, -1, 1.5, NaN, Infinity, MAX_FRAME_BYTES + 1])('rejects a limit that is not tighter: %s', (limit) => {
    for (const key of ['maxInputBytes', 'maxOutputBytes'] as const) {
      expect(() => new ContractRegistry().register(definition({ [key]: limit }))).toThrow();
    }
  });

  it.each(['input', 'output'] as const)('copies and deeply freezes validated %s with escaped Unicode', (kind) => {
    const { registry, contract } = installed({
      input: z.strictObject({ rows: z.array(z.strictObject({ text: z.string() })) }),
      output: z.strictObject({ rows: z.array(z.strictObject({ text: z.string() })) }),
    });
    const source = { rows: [{ text: '\u754c\u{1f680}' }] };
    const result = registry.validate(contract, kind, source);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected validated payload');
    expect(result.payload).toEqual(source);
    expect(result.payload).not.toBe(source);
    expect(Object.isFrozen(result.payload)).toBe(true);
    expect(Object.isFrozen((result.payload as typeof source).rows)).toBe(true);
    expect(Object.isFrozen((result.payload as typeof source).rows[0])).toBe(true);
    source.rows[0].text = 'changed';
    expect(result.payload).toEqual({ rows: [{ text: '\u754c\u{1f680}' }] });
  });

  it.each(['input', 'output'] as const)('enforces the exact UTF8 byte limit for %s', (kind) => {
    const value = kind === 'input' ? { query: '\u754c' } : { value: '\u754c' };
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    const { registry, contract } = installed({ maxInputBytes: bytes, maxOutputBytes: bytes });
    expect(registry.validate(contract, kind, value)).toEqual({ success: true, payload: value });
    const tooLarge = kind === 'input' ? { query: '\u754cx' } : { value: '\u754cx' };
    expect(registry.validate(contract, kind, tooLarge)).toEqual({ success: false, code: `invalid_${kind}` });
  });

  it.each(['input', 'output'] as const)('rejects invalid %s before calling its validator', (kind) => {
    const transform = vi.fn((value: unknown) => value);
    const schema = z.unknown().transform(transform);
    const { registry, contract } = installed({ input: schema, output: schema });
    const getter = vi.fn(() => 'hidden');
    const unsafe = Object.defineProperty({}, 'query', { enumerable: true, get: getter });
    expect(registry.validate(contract, kind, unsafe)).toEqual({ success: false, code: `invalid_${kind}` });
    expect(getter).not.toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();
    for (const value of [undefined, NaN, 1n, new Date(0)]) {
      expect(registry.validate(contract, kind, value)).toEqual({ success: false, code: `invalid_${kind}` });
    }
    expect(transform).not.toHaveBeenCalled();
  });

  it.each(['input', 'output'] as const)('rejects schema errors and extra fields for %s', (kind) => {
    const { registry, contract } = installed();
    for (const value of [null, {}, { query: 1 }, { value: 1 }, { query: 'page', value: 'page' }]) {
      expect(registry.validate(contract, kind, value)).toEqual({ success: false, code: `invalid_${kind}` });
    }
  });

  it.each(['input', 'output'] as const)('catches validator exceptions and rechecks transformed %s', (kind) => {
    for (const transform of [
      () => { throw new Error('Validator failed'); },
      () => undefined,
      () => new Date(0),
      () => 'x'.repeat(33),
    ]) {
      const schema = z.unknown().transform((): unknown => transform());
      const { registry, contract } = installed({ input: schema, output: schema, maxInputBytes: 32, maxOutputBytes: 32 });
      expect(registry.validate(contract, kind, 'page')).toEqual({ success: false, code: `invalid_${kind}` });
    }
  });
});

describe('feature node authority', () => {
  it('takes a frozen snapshot and rechecks live grants and permission versions', () => {
    let current = authority();
    const lookup = vi.fn(() => current);
    const bound = readAuthority(lookup, 'node-a', 'account-a')!;
    expect(bound).toEqual(current);
    expect(bound).not.toBe(current);
    for (const value of [bound, bound.grants, bound.grants[0], bound.grants[0].capability]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(isAuthorized(lookup, bound, capability, fingerprint, 1)).toBe(true);
    expect(isAuthorized(lookup, bound, capability, fingerprint, 2)).toBe(false);
    current = { ...current, permissionVersion: 2 };
    expect(isAuthorized(lookup, bound, capability, fingerprint, 1)).toBe(false);
    expect(isAuthorized(lookup, bound, capability, fingerprint, 2)).toBe(false);
    current = { ...current, permissionVersion: 1, grants: [] };
    expect(isAuthorized(lookup, bound, capability, fingerprint, 1)).toBe(false);
    expect(bound.grants).toHaveLength(1);
  });

  it('requires both the bound and current grants with exact fingerprint and version', () => {
    const granted = authority();
    const bound = readAuthority(() => granted, 'node-a', 'account-a')!;
    expect(isAuthorized(() => granted, bound, capability, 'catalog-v2', 1)).toBe(false);
    expect(isAuthorized(() => granted, bound, { ...capability, version: 2 }, fingerprint, 1)).toBe(false);
    const ungranted = { ...granted, grants: [] };
    const emptyBound = readAuthority(() => ungranted, 'node-a', 'account-a')!;
    expect(isAuthorized(() => granted, emptyBound, capability, fingerprint, 1)).toBe(false);
    expect(isAuthorized(() => ungranted, bound, capability, fingerprint, 1)).toBe(false);
  });

  it.each([
    undefined,
    { ...authority(), nodeId: 'node-b' },
    { ...authority(), accountId: 'account-b' },
    { ...authority(), permissionVersion: -1 },
    { ...authority(), permissionVersion: 1.5 },
    { ...authority(), permissionVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...authority(), extra: 'untrusted' },
    { ...authority(), grants: [{ capability, fingerprint, readOnly: true }] },
    { ...authority(), grants: [{ capability: { ...capability, version: 0 }, fingerprint }] },
    { ...authority(), grants: Array.from({ length: 65 }, () => ({ capability, fingerprint })) },
  ])('fails closed on a missing or malformed authority %#', (value) => {
    const lookup = () => value as Authority | undefined;
    expect(readAuthority(lookup, 'node-a', 'account-a')).toBeUndefined();
    expect(isAuthorized(lookup, authority(), capability, fingerprint, 1)).toBe(false);
  });

  it('catches lookup failures without executing authority getters', () => {
    const lookup = () => { throw new Error('Authority lookup failed'); };
    expect(readAuthority(lookup, 'node-a', 'account-a')).toBeUndefined();
    expect(isAuthorized(lookup, authority(), capability, fingerprint, 1)).toBe(false);
    const getter = vi.fn(() => 'node-a');
    const unsafe = Object.defineProperty(authority(), 'nodeId', { enumerable: true, get: getter });
    expect(readAuthority(() => unsafe, 'node-a', 'account-a')).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });
});
