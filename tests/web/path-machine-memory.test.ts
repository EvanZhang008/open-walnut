import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.assign(globalThis, {
    window: {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
    },
  });
});
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });

const { forgetMachine, rememberMachine, rememberedMachine } = await import('../../web/src/utils/path-machine-memory');

describe('the machine a person named for a path', () => {
  it('is kept per path and given back only for that path; forgetting removes it', () => {
    expect(rememberedMachine('/a/b.txt')).toBeNull();
    rememberMachine('/a/b.txt', '__local__');
    rememberMachine('/c/d.txt', 'devbox');
    expect(rememberedMachine('/a/b.txt')).toBe('__local__');
    expect(rememberedMachine('/c/d.txt')).toBe('devbox');
    expect(rememberedMachine('/a/other.txt')).toBeNull();
    forgetMachine('/a/b.txt');
    expect(rememberedMachine('/a/b.txt')).toBeNull();
    expect(rememberedMachine('/c/d.txt')).toBe('devbox');
  });

  it('keeps the newest 50 paths and a changed choice replaces the old one', () => {
    for (let i = 0; i < 60; i++) rememberMachine(`/p/${i}.txt`, 'h');
    expect(rememberedMachine('/p/0.txt')).toBeNull();
    expect(rememberedMachine('/p/59.txt')).toBe('h');
    rememberMachine('/p/59.txt', 'other');
    expect(rememberedMachine('/p/59.txt')).toBe('other');
    expect(Object.keys(JSON.parse([...store.values()][0]!))).toHaveLength(50);
  });

  it('reads nothing and breaks nothing when storage is missing, blocked or holds junk', () => {
    store.set('walnut.pathMachine.v1', 'not json');
    expect(rememberedMachine('/a')).toBeNull();
    store.set('walnut.pathMachine.v1', '[1,2]');
    expect(rememberedMachine('/a')).toBeNull();
    Object.assign(globalThis, { window: {} });
    expect(rememberedMachine('/a')).toBeNull();
    expect(() => rememberMachine('/a', 'h')).not.toThrow();
    expect(() => forgetMachine('/a')).not.toThrow();
  });
});
