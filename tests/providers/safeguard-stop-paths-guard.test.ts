/**
 * Every path that ends a turn tells the safeguard switch when the model's safeguards refused it.
 *
 * 2026-11-11: sessions got "API Error: Opus 5.5's safeguards flagged this message" turn after turn
 * and stayed stuck until the user typed /model. The switch (src/core/sessions/safeguard-switch.ts)
 * acts on `safeguardStop` on session:result, so a turn-end path that leaves it off is a refused
 * session nobody moves. This guard lists every place in src/ that emits session:result: each one
 * stamps the fact (`safeguardStopFields(` for Claude Code, the ACP stop reason in acp-session.ts),
 * or is listed below with why it cannot carry a refusal. A new path fails until it does one or the other.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Emits that cannot end a refused turn, each found by a marker inside its payload, with the reason. */
const EXEMPT: Array<{ file: string; marker: RegExp; why: string }> = [
  {
    file: 'src/providers/claude-code-session.ts', marker: /result: this\.fullText,\s*isError: false,\s*\}/,
    why: 'the process died and its result in the output file was clean (an error result there goes out as session:error)',
  },
  {
    file: 'src/providers/claude-code-session.ts', marker: /processDied: true/,
    why: 'the process died with no result at all: no turn the model answered or refused',
  },
  {
    file: 'src/providers/claude-code-session.ts', marker: /\{ \.\.\.rawData, sessionId: resolvedSessionId \}/,
    why: 'a copy of a result already published, for the browser only (web-ui), with every field of it kept',
  },
  {
    file: 'src/web/routes/session-stream-v1.ts', marker: /emitSse\(key, 'turn-end'/,
    why: 'the phone\'s stream reading a published result, not a turn end of its own',
  },
  {
    file: 'src/providers/acp-stream-normalizer.ts', marker: /stopReason: event\.stopReason/,
    why: 'the normalized ACP result: acp-session.ts stamps its refusal from this stopReason (checked below)',
  },
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
}

/** The payload of each session:result emit: from the emit to the end of its object literal. */
function resultEmits(src: string): string[] {
  const out: string[] = [];
  // Any emit of the event (bus.emit, this.emitEvent, a relay's emit(busEventName) under its case),
  // and any frame object named for it.
  const re = /\bemit\w*\(\s*(?:EventNames\.SESSION_RESULT|'session:result')\s*,|name: 'session:result'|case 'session:result':\s*\{[^{]*?\bemit\w*\(\s*\w+\s*,/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    out.push(src.slice(m.index, end + 1));
  }
  return out;
}

describe('every session:result tells the safeguard switch about a refused turn', () => {
  const files: string[] = [];
  walk(path.join(ROOT, 'src'), files);
  const emits = files.flatMap((f) => {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    return resultEmits(readFileSync(f, 'utf8')).map((body) => ({ rel, body }));
  });

  it('finds the emits (the scan itself works)', () => {
    expect(emits.filter((e) => e.rel === 'src/providers/claude-code-session.ts').length).toBeGreaterThanOrEqual(6);
    expect(emits.some((e) => e.rel === 'src/providers/acp-stream-normalizer.ts')).toBe(true);
    // The SDK session server and its relay (this.emitEvent, emit(busEventName) under the case).
    expect(emits.some((e) => e.rel === 'src/session-server/sdk-session.ts')).toBe(true);
    expect(emits.some((e) => e.rel === 'src/providers/session-server-client.ts')).toBe(true);
  });

  it('each one stamps safeguardStop or is listed with why it cannot carry a refusal', () => {
    const bad = emits.filter((e) => !/safeguardStopFields\(|safeguardStop\b/.test(e.body)
      && !EXEMPT.some((x) => x.file === e.rel && x.marker.test(e.body)));
    expect(bad.map((e) => `${e.rel}: ${e.body.slice(0, 160).replace(/\s+/g, ' ')}`)).toEqual([]);
  });

  it('every exemption still matches an emit (a stale one fails)', () => {
    for (const x of EXEMPT) {
      expect(emits.some((e) => e.rel === x.file && x.marker.test(e.body)), `${x.file} ${x.marker}`).toBe(true);
    }
  });

  it('the ACP session stamps its refusal on the result it publishes', () => {
    const acp = readFileSync(path.join(ROOT, 'src/providers/acp-session.ts'), 'utf8');
    expect(acp).toMatch(/name === 'session:result'[^\n]*\n[\s\S]{0,200}safeguardStopOfAcpStopReason\(full\.stopReason\)/);
  });

  it('Claude Code\'s refusal is read where its error reply and its result line are handled', () => {
    const cc = readFileSync(path.join(ROOT, 'src/providers/claude-code-session.ts'), 'utf8');
    expect(cc).toMatch(/safeguardStopOfCliLine\(msg/);
    expect(cc).toMatch(/safeguardStopOfResult\(result/);
    // Reset at every turn start, as the usage-limit facts are.
    expect(cc.match(/this\._turnSafeguardStop = null/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
