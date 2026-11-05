/**
 * Every browser spec that makes, answers or clears approvals on the fixture server holds the
 * approvals lock (tests/e2e/browser/approvals-lock.ts).
 *
 * The waiting approvals are one list a fixture server shares, and Playwright runs other files
 * against that server at once. 2026-11-05, the push gate: notice-full-text's afterEach denied every
 * waiting approval, approvals.spec's Face ID request among them, 0.8 s after that file made it on
 * the next worker, and its card never showed. This reads every spec and fails on one that reaches
 * `/api/v1/approvals` without calling holdApprovalsLock, or clears approvals with its own loop.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../e2e/browser');
const specs = fs.readdirSync(DIR).filter((f) => f.endsWith('.spec.ts'));

/** The code of a spec, comment lines left out (a comment may name the route). */
function code(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

const users = specs.filter((f) => /\/api\/v1\/approvals/.test(code(f)));

describe('approvals lock', () => {
  it('finds the specs it knows of (the matcher still matches)', () => {
    for (const known of ['approvals.spec.ts', 'notice-full-text.spec.ts', 'extension-agent.spec.ts', 'extension-agent-outward.spec.ts']) {
      expect(users, known).toContain(known);
    }
  });

  it('every spec that reaches the approvals routes holds the lock', () => {
    const missing = users.filter((f) => !/\bholdApprovalsLock\('(file|test)'/.test(code(f)));
    expect(missing, 'call holdApprovalsLock() from ./approvals-lock at the top level of these specs').toEqual([]);
  });

  it('a serial file holds it per file, any other file per test', () => {
    const wrong = users.filter((f) => {
      const src = code(f);
      return /mode:\s*'serial'/.test(src) !== /holdApprovalsLock\('file'/.test(src);
    });
    expect(wrong).toEqual([]);
  });

  it('no spec clears the waiting approvals itself: only the lock\'s clear does, inside the lock', () => {
    // A loop over the list that answers each one, the shape both copies had.
    const own = users.filter((f) => /for \(const \w+ of approvals\)[^\n]*\/answer/.test(code(f)));
    expect(own, "pass { clear: true } to holdApprovalsLock instead").toEqual([]);
  });
});
