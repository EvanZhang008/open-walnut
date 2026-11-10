/**
 * No test waits for a fake timer to be armed by spinning microtasks.
 *
 * Code that reaches its timer through a dynamic import or other real I/O arms it only after a
 * real loop turn. A loop of `await Promise.resolve()` until `vi.getTimerCount()` is non-zero can
 * end first on a loaded machine; the fake clock is then moved before the timer exists, never
 * fires it, and the test hangs to its timeout (2026-11-10: a rewind test failed that way twice in
 * a day on GitHub's runners, and the flaky rule refused every push of main and every land whose
 * gate ran it). Wait with `waitForFakeTimer()` from tests/helpers/fake-timer-pump.ts instead,
 * which yields real macrotasks.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const TESTS = join(ROOT, 'tests');
// A loop that waits on the timer count with microtask hops only.
const SPIN = /getTimerCount\(\)\s*===?\s*0[^\n]*await\s+Promise\.resolve\(\)|await\s+Promise\.resolve\(\)[^\n]*getTimerCount\(\)\s*===?\s*0/;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p);
  }
  return out;
}

describe('fake timers are waited for with real turns', () => {
  it('no test spins microtasks until a fake timer is armed', () => {
    const self = relative(ROOT, __filename);
    const hits = files(TESTS)
      .filter((p) => relative(ROOT, p) !== self)
      .flatMap((p) => readFileSync(p, 'utf8').split('\n').map((line, i) => ({ p, line, i })))
      .filter(({ line }) => SPIN.test(line))
      .map(({ p, i }) => `${relative(ROOT, p)}:${i + 1}`);
    expect(hits, 'wait with waitForFakeTimer() (tests/helpers/fake-timer-pump.ts)').toEqual([]);
  });

  it('the pattern still catches the loop it was written for', () => {
    expect(SPIN.test('for (let i = 0; i < 200 && vi.getTimerCount() === 0; i++) await Promise.resolve();')).toBe(true);
    expect(SPIN.test('expect(await waitForFakeTimer()).toBeGreaterThan(0);')).toBe(false);
  });
});
