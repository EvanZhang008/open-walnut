/**
 * Unit test: where `walnut tools call` reads its JSON arguments from.
 *
 * The rule set exists because of a failure that never reaches Walnut code: on
 * Linux the kernel caps ONE argv entry at MAX_ARG_STRLEN (128KB), so a letter
 * carrying inline base64 audio dies in execve with "Argument list too long".
 * `@file` and `-` are the descriptor-based ways in, and both CLI faces (the
 * in-session `walnut` bundled into the daemon, and the hub command) share this
 * classifier so they can never disagree about what an argument means.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyArgsSource,
  parseToolArgs,
} from '../../../src/providers/tool-args-source.js';

describe('classifyArgsSource', () => {
  it('treats ordinary text as inline JSON, verbatim', () => {
    expect(classifyArgsSource('{"a":1}', true)).toEqual({ kind: 'inline', json: '{"a":1}' });
    // Surrounding whitespace decides nothing but is not eaten from the payload.
    expect(classifyArgsSource(' {"a":1} ', true)).toEqual({ kind: 'inline', json: ' {"a":1} ' });
  });

  it('reads a file for @path', () => {
    expect(classifyArgsSource('@/tmp/letter.json', true)).toEqual({ kind: 'file', path: '/tmp/letter.json' });
    expect(classifyArgsSource('@relative/args.json', true)).toEqual({ kind: 'file', path: 'relative/args.json' });
  });

  it('rejects a bare @ with a usage error instead of reading the cwd', () => {
    const res = classifyArgsSource('@', true);
    expect(res.kind).toBe('usage-error');
  });

  it('reads stdin for an explicit -, even on a terminal', () => {
    expect(classifyArgsSource('-', true)).toEqual({ kind: 'stdin' });
  });

  /**
   * The absent case is the one that must NOT hang: a piped stdin is arguments,
   * an interactive terminal means "no arguments" (otherwise a bare
   * `walnut tools call task_list` would sit waiting for the human to type EOF).
   */
  it('falls back to stdin only when stdin is a pipe', () => {
    expect(classifyArgsSource(undefined, false)).toEqual({ kind: 'stdin' });
    expect(classifyArgsSource(undefined, true)).toEqual({ kind: 'none' });
  });

  it('treats an empty argument as no arguments', () => {
    expect(classifyArgsSource('   ', true)).toEqual({ kind: 'none' });
  });
});

describe('parseToolArgs', () => {
  it('parses an object', () => {
    expect(parseToolArgs('{"id":"abc"}')).toEqual({ ok: true, args: { id: 'abc' } });
  });

  it('treats blank input as an empty argument object', () => {
    expect(parseToolArgs('')).toEqual({ ok: true, args: {} });
    expect(parseToolArgs('\n  \n')).toEqual({ ok: true, args: {} });
  });

  it('names the problem for JSON that is not an object', () => {
    for (const raw of ['[1,2]', '"hi"', '42', 'null']) {
      const res = parseToolArgs(raw);
      expect(res.ok, raw).toBe(false);
      if (!res.ok) expect(res.message).toMatch(/JSON object/);
    }
  });

  it('reports malformed JSON rather than throwing', () => {
    const res = parseToolArgs('{not json');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/invalid JSON/);
  });

  /** A multi-MB letter payload is the reason @file exists — it must parse. */
  it('parses a multi-MB payload', () => {
    const html = `<audio src="data:audio/mpeg;base64,${'A'.repeat(2 * 1024 * 1024)}">`;
    const res = parseToolArgs(JSON.stringify({ subject: 'Digest', type: 'info', html }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.args.html).toBe(html);
  });
});
