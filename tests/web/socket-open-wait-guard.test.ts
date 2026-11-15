/**
 * Guard: a browser spec that waits for the page's socket to open gives that wait at least a cold
 * boot on a loaded runner.
 *
 * The page opens its socket only once the app has booted (web/src/main.tsx mounts App after the
 * shell's chunks load; App's useWebSocket connects). On a quiet dev box that is about 4 s; on a CI
 * runner whose four workers boot pages at once it took about 12 s. The shared harness waited 10 s
 * (tests/e2e/browser/mock-session-harness.ts `waitForWs`), so on 2026-11-14 every
 * turn-fold-matrix test that waited for the socket failed in CI (292 of 309 in the shard that ran
 * mostly that spec) while the same tests passed alone; with Chromium's CPU slowed six times the
 * same wait failed on a dev box too (boot to open socket: 3.9 s plain, 8.9 s at 4x, 14 s at 6x).
 *
 * The class: every `page.waitForFunction` whose predicate checks a socket's `readyState` against
 * OPEN. A member either names no timeout (the test's own budget bounds it) or names at least
 * SOCKET_OPEN_MIN_MS.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPECS = join(__dirname, '../e2e/browser');
const SOCKET_OPEN_MIN_MS = 30_000;
const OPEN_CHECK = /readyState\s*===\s*(?:WebSocket\.OPEN|1)\b/;

/** Each `waitForFunction(...)` call in a source, as its full text and its line. */
function waitCalls(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  for (let at = src.indexOf('waitForFunction('); at !== -1; at = src.indexOf('waitForFunction(', at + 1)) {
    let depth = 0;
    let end = at;
    for (let i = at + 'waitForFunction'.length; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) { end = i; break; }
    }
    out.push({ text: src.slice(at, end + 1), line: src.slice(0, at).split('\n').length });
  }
  return out;
}

describe('a wait for the page socket outlasts a cold boot', () => {
  const members = readdirSync(SPECS).filter((f) => f.endsWith('.ts')).flatMap((f) =>
    waitCalls(readFileSync(join(SPECS, f), 'utf8')).filter((c) => OPEN_CHECK.test(c.text)).map((c) => ({ ...c, file: f })));

  it('finds the known members (the scan still reads the specs)', () => {
    expect(members.map((m) => m.file)).toEqual(expect.arrayContaining(['mock-session-harness.ts', 'ws-capture-helpers.ts']));
    expect(members.length).toBeGreaterThan(40);
  });

  it('no member waits less than a cold boot', () => {
    const short = members.flatMap((m) => {
      const t = /timeout:\s*([\d_]+)/.exec(m.text);
      const ms = t ? Number(t[1].replace(/_/g, '')) : Infinity;
      return ms < SOCKET_OPEN_MIN_MS ? [`${m.file}:${m.line} waits ${ms} ms`] : [];
    });
    expect(short, `give the socket wait at least ${SOCKET_OPEN_MIN_MS} ms (or no timeout): a loaded CI runner boots the page in about 12 s`).toEqual([]);
  });
});
