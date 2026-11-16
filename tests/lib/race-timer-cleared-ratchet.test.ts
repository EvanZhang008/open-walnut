/**
 * Race-timer ratchet: a deadline clock that logs must be cleared when the work wins.
 *
 * 2026-11-16: `getSessionWorkflowPayload` raced its read against
 * `new Promise(r => setTimeout(() => { log.warn('... timed out'); r(null) }, 5000))`
 * and never cleared the clock. The read answered in 3 ms, the route sent its 204,
 * and 5 s later the warning fired anyway: every slow-path call logged a false
 * timeout, enough to trip the health monitor's log-spike alarm.
 *
 * The class: a `Promise.race` whose timer callback has a side effect (a log line,
 * an emit, an abort) and whose clock nobody clears. Every member in src/ and
 * web/src/ fails this test. Use `withDeadline` (src/lib/with-deadline.ts), which
 * clears its clock when the work settles and runs `onTimeout` only on a real
 * timeout, or clear the timer yourself (clearTimeout in a finally).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOTS = ['src', 'web/src'];
const SIDE_EFFECT = /\blog\.|console\.|\.emit\(|\.abort\(|\.kill\(|notify\(/;
/** How far after a race a clearTimeout still counts as clearing its clock. */
const CLEAR_WINDOW_CHARS = 800;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Index of the paren closing the one at `open` (string contents are not special-cased; good enough for call sites). */
function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return src.length - 1;
}

/** The callback text of every `setTimeout(` inside `text` (its first argument). */
function timerCallbacks(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while ((at = text.indexOf('setTimeout(', at)) >= 0) {
    const open = at + 'setTimeout'.length;
    const close = closingParen(text, open);
    out.push(text.slice(open + 1, close));
    at = close;
  }
  return out;
}

/** Line numbers of uncleared side-effecting race timers in one source text. */
function unclearedRaceTimers(src: string): number[] {
  const hits: number[] = [];
  const lineOf = (i: number) => src.slice(0, i).split('\n').length;

  // Inline: Promise.race([work, new Promise(r => setTimeout(() => { log...; r() }, ms))])
  let at = 0;
  while ((at = src.indexOf('Promise.race(', at)) >= 0) {
    const open = at + 'Promise.race'.length;
    const close = closingParen(src, open);
    const race = src.slice(at, close + 1);
    const logs = timerCallbacks(race).some((cb) => SIDE_EFFECT.test(cb));
    if (logs && !/clearTimeout/.test(race) && !/clearTimeout/.test(src.slice(close, close + CLEAR_WINDOW_CHARS))) {
      hits.push(lineOf(at));
    }
    at = close;
  }

  // Out of line: const deadline = new Promise(r => setTimeout(() => { log...; r() }, ms)); ...Promise.race([work, deadline])
  const decl = /(?:const|let)\s+(\w+)\s*=\s*new Promise\b/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src))) {
    const name = m[1];
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const close = closingParen(src, open);
    const body = src.slice(open, close + 1);
    if (!timerCallbacks(body).some((cb) => SIDE_EFFECT.test(cb)) || /clearTimeout/.test(body)) continue;
    const rest = src.slice(close, close + 3000);
    const raced = new RegExp(`Promise\\.race\\(\\s*\\[[^\\]]*\\b${name}\\b`).test(rest);
    if (raced && !/clearTimeout/.test(rest)) hits.push(lineOf(m.index));
  }
  return hits;
}

describe('race timers that log are cleared when the work wins', () => {
  it('catches the shape that shipped (and passes the fixed shapes)', () => {
    const shipped = `
      const payload = await Promise.race([
        reconstruct(id),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => {
            log.web.warn('workflow reconstruct timed out', { id });
            resolve(null);
          }, 5000);
          t.unref?.();
        }),
      ]);`;
    const outOfLine = `
      const deadline = new Promise<null>((resolve) => setTimeout(() => { log.web.warn('late'); resolve(null) }, 5000));
      const payload = await Promise.race([reconstruct(id), deadline]);`;
    const cleared = `
      let timer;
      try {
        return await Promise.race([work, new Promise((_, rej) => { timer = setTimeout(() => { log.x.warn('late'); rej(new Error('t')) }, 9) })]);
      } finally { clearTimeout(timer) }`;
    const silent = `await Promise.race([work, new Promise((r) => setTimeout(r, 9))]);`;
    expect(unclearedRaceTimers(shipped)).toHaveLength(1);
    expect(unclearedRaceTimers(outOfLine)).toHaveLength(1);
    expect(unclearedRaceTimers(cleared)).toEqual([]);
    expect(unclearedRaceTimers(silent)).toEqual([]);
  });

  it('no file in src/ or web/src/ races an uncleared clock that logs', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(path.join(repoRoot, root))) {
        const src = fs.readFileSync(file, 'utf8');
        if (!src.includes('Promise.race')) continue;
        for (const line of unclearedRaceTimers(src)) offenders.push(`${path.relative(repoRoot, file)}:${line}`);
      }
    }
    expect(
      offenders,
      'A Promise.race timer here logs (or emits/aborts) but is never cleared, so it fires after the work already won. ' +
        'Use withDeadline from src/lib/with-deadline.ts, or clearTimeout in a finally.',
    ).toEqual([]);
  });
});
