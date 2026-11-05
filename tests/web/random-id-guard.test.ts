/**
 * No bare `crypto.randomUUID()` in the web app (2026-11-05: on a plain-http address,
 * an insecure context, it is undefined; opening a column created a notification with
 * a bare call and the page fell into its error boundary). New ids come from
 * `randomId()` (web/src/utils/random-id.ts), or from a call guarded by a
 * `typeof ... === 'function'` check on the line itself or the one before. This test
 * fails on the next bare call.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../web/src');
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('random ids work in an insecure context', () => {
  it('every crypto.randomUUID() call is guarded or goes through randomId()', () => {
    const bare: string[] = [];
    for (const file of sources(ROOT)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/\bcrypto\.randomUUID\(\)/.test(line)) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const near = `${lines[i - 1] ?? ''}\n${line}`;
        if (/typeof\s+[\w.?]*randomUUID\s*===\s*'function'/.test(near)) return;
        bare.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bare).toEqual([]);
  });

  it('randomId() gives a v4 uuid without crypto.randomUUID', async () => {
    const { randomId } = await import('../../web/src/utils/random-id');
    const saved = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
    try {
      const a = randomId();
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(randomId()).not.toBe(a);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: saved, configurable: true, writable: true });
    }
  });
});
