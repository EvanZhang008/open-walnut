import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimAgentRef, parseAgentRef, registerAgentRef } from '../../web/src/utils/agent-ref-open';

beforeEach(() => vi.stubGlobal('window', { location: { origin: 'http://localhost:3457' } }));
afterEach(() => vi.unstubAllGlobals());
const link = (params: Record<string, string>) => `http://localhost:3457/open-ref#${new URLSearchParams(params)}`;

describe('agent document references', () => {
  it('a file keeps its decoded path and line range', () => {
    expect(parseAgentRef(link({ kind: 'file', path: '/tmp/Output File.ts', line: '10', endLine: '20', token: 'document-token' }))).toEqual({ token: 'document-token', ref: { kind: 'file', path: '/tmp/Output File.ts', line: 10, endLine: 20 } });
  });
  it.each(['/tmp/../private.txt', '//example.com/file', '/tmp/a' + String.fromCodePoint(0) + '.txt', '/tmp/a' + String.fromCodePoint(127) + '.txt', 'relative/file.ts'])('rejects an unsafe file reference: %s', (path) => {
    expect(parseAgentRef(link({ kind: 'file', path }))).toBeNull();
  });
  it('external pages and unknown reference kinds cannot open files', () => {
    expect(parseAgentRef('https://example.com/open-ref#kind=file&path=/tmp/a.txt')).toBeNull();
    expect(parseAgentRef(link({ kind: 'command', id: 'run' }))).toBeNull();
  });
  it('only a mounted document token opens automatically, and unmount revokes it', () => {
    const open = vi.fn();
    const href = link({ kind: 'file', path: '/tmp/a.txt', token: 'random-token' });
    expect(claimAgentRef(href)).toBe(false);
    const unregister = registerAgentRef('random-token', open);
    expect(claimAgentRef(href)).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith({ kind: 'file', path: '/tmp/a.txt' });
    expect(claimAgentRef(href)).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
    unregister();
    expect(claimAgentRef(href)).toBe(false);
  });
  it('task and letter references preserve validated ids', () => {
    expect(parseAgentRef(link({ kind: 'task', id: 'mvu0ubnq-a02d' }))?.ref).toEqual({ kind: 'task', id: 'mvu0ubnq-a02d' });
    expect(parseAgentRef(link({ kind: 'letter', id: 'lt-m9x2k1-a4f7' }))?.ref).toEqual({ kind: 'letter', id: 'lt-m9x2k1-a4f7' });
    expect(parseAgentRef(link({ kind: 'letter', id: 'not-a-letter' }))).toBeNull();
  });
});
