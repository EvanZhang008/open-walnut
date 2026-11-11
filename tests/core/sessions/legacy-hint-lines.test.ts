/**
 * The legacy-hint cutoff a daemon's parse takes for one call (src/core/sessions/legacy-hint-lines.ts
 * withLegacyHintCutoff, history-parse.ts `legacyHintCutoffMs`). A daemon serves several servers, so
 * one asking server's cutoff must never stay set for the next parse: it holds for one synchronous
 * call, is put back after it (also when it throws, also when nested), and a parse without the
 * option reads the process's own.
 */
import { describe, it, expect } from 'vitest';
import { legacyHintCutoff, stripLegacyHintLines, withLegacyHintCutoff } from '../../../src/core/sessions/legacy-hint-lines.js';
import { parseSessionMessages } from '../../../src/core/history-parse.js';

const line = (text: string, timestamp: string) => JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp, message: { role: 'user', content: text } });

describe('withLegacyHintCutoff', () => {
  it('holds for the call only, nested and on a throw', () => {
    const own = legacyHintCutoff();
    expect(withLegacyHintCutoff(5, () => legacyHintCutoff())).toBe(5);
    expect(withLegacyHintCutoff(5, () => withLegacyHintCutoff(9, () => legacyHintCutoff()) + legacyHintCutoff())).toBe(14);
    expect(() => withLegacyHintCutoff(5, () => { throw new Error('boom'); })).toThrow('boom');
    expect(legacyHintCutoff()).toBe(own);
    expect(withLegacyHintCutoff(undefined, () => legacyHintCutoff())).toBe(own);
    expect(withLegacyHintCutoff(Number.NaN, () => legacyHintCutoff())).toBe(own);
  });

  it('a parse with the option strips by it; one without reads the process cutoff', () => {
    const at = '2026-08-30T00:00:00.000Z';
    const text = 'hello there\n\n[Reply language: English]';
    const after = Date.UTC(2027, 0, 1);
    const before = Date.UTC(2020, 0, 1);
    expect(parseSessionMessages(line(text, at), { legacyHintCutoffMs: after })[0]!.text).toBe('hello there');
    expect(parseSessionMessages(line(text, at), { legacyHintCutoffMs: before })[0]!.text).toContain('[Reply language: English]');
    // The process's own cutoff is untouched by either, and still decides a plain call.
    const own = legacyHintCutoff();
    expect(parseSessionMessages(line(text, at))[0]!.text).toBe(stripLegacyHintLines(text, at));
    expect(legacyHintCutoff()).toBe(own);
  });
});
