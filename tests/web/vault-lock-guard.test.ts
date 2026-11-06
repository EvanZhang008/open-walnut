/**
 * Every browser spec that uses the fixture's shared Passwords vault holds the vault lock
 * (tests/e2e/browser/vault-lock.ts), and every spec that ends every unlock holds it alone.
 *
 * One vault serves every spec on a fixture server, and Playwright runs other files against it at
 * once. 2026-11-06, D02 round 2: a combined run of the extension, Passwords and approvals specs
 * failed 5 of 195, each right after another file's Lock all, popup Lock or Lock of every window
 * (a key popover read locked, a popup said "Walnut is locked", a second tab never opened
 * unlocked), and one spec that names its extension for sharing an unlock shared another file's
 * new unlock a moment after its own Lock. This reads every spec, finds what ends every unlock from
 * the code (the UI's Lock and Lock all, the popup's Lock, the lock route with `all` or
 * `everywhere`, a new master password, a recovery, a setup through the UI, naming a joiner), and
 * fails on a spec that does one without holding the vault lock exclusive.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../e2e/browser');
const specs = fs.readdirSync(DIR).filter((f) => f.endsWith('.spec.ts'));

/** The code of a spec, comment lines left out (a comment may name a route or a button). */
function code(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/** It uses the fixture's vault: the helper, a vault route, the master password field, a vault view. */
const USES = [
  /from '\.\/vault-session-helper'/,
  /\/api\/v1\/vault\//,
  /getByLabel\('Master password'\)/,
  /getByTestId\('(pw-unlock|pw-app|popup-unlock|popup-lock|key-pop)'\)/,
];

/** A line that ends every unlock, changes the master password, recovers or sets the vault up. */
const ENDS_EVERY_UNLOCK: Array<[string, RegExp]> = [
  ["a person's Lock (every window)", /getByTestId\('pw-lock'\)\.click\(/],
  ['Lock all', /name: 'Lock all'/],
  ["the extension popup's Lock (every window)", /getByTestId\('popup-lock'\)\.click\(/],
  ['the lock route with all or everywhere', /\/api\/v1\/vault\/lock\b.*\b(all|everywhere)\s*:\s*true/],
  ['a new master password', /\/api\/v1\/vault\/password\b|'Change master password'[^\n]*\.click\(/],
  ['a recovery', /\/api\/v1\/vault\/recover\b|'pw-recover'|'Set new master password'/],
  ['a setup through the UI', /#pw-setup-1|name: 'Create vault'/],
];

/** Naming a device or window for sharing an unlock: every unlock made beside the spec reaches it. */
const NAMES_JOINER = /\/api\/test\/vault-join/;

const users = specs.filter((f) => USES.some((re) => re.test(code(f))));
const holdOf = (src: string): { mode: string; scope: string } | null => {
  const m = /\bholdVaultLock\('(shared|exclusive)', '(file|test)'\)/.exec(src);
  return m ? { mode: m[1], scope: m[2] } : null;
};

/** The [start, end) ranges of the code inside each `vaultExclusively(...)` call. */
function exclusiveRanges(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /\bvaultExclusively\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.push([m.index, i]);
  }
  return out;
}

/** Each place in a spec that ends every unlock and is not inside a vaultExclusively step. */
function bareEnders(src: string): string[] {
  const ranges = exclusiveRanges(src);
  const found: string[] = [];
  let offset = 0;
  for (const line of src.split('\n')) {
    for (const [what, re] of ENDS_EVERY_UNLOCK) {
      const m = re.exec(line);
      const at = m ? offset + m.index : -1;
      if (m && !ranges.some(([a, b]) => at >= a && at < b)) found.push(`${what}: ${line.trim().slice(0, 120)}`);
    }
    offset += line.length + 1;
  }
  return found;
}

describe('vault lock', () => {
  it('finds the specs it knows of (the matchers still match)', () => {
    for (const known of ['passwords.spec.ts', 'extension-passwords.spec.ts', 'extension-ask-panel.spec.ts', 'vault-live.spec.ts', 'approvals.spec.ts']) {
      expect(users, known).toContain(known);
    }
    // Each kind of ender is still found somewhere, so a renamed button or route shows here.
    const all = specs.map(code).join('\n');
    for (const [what, re] of ENDS_EVERY_UNLOCK.filter(([w]) => w !== 'a new master password')) expect(re.test(all), what).toBe(true);
    expect(NAMES_JOINER.test(all)).toBe(true);
  });

  it('every spec that uses the fixture vault holds the vault lock', () => {
    const missing = users.filter((f) => !holdOf(code(f)));
    expect(missing, "call holdVaultLock() from ./vault-lock at the top level of these specs").toEqual([]);
  });

  it('a spec that ends every unlock holds it exclusive, or ends them only inside vaultExclusively', () => {
    const wrong = users.flatMap((f) => {
      const src = code(f);
      if (holdOf(src)?.mode === 'exclusive') return [];
      return bareEnders(src).map((e) => `${f}: ${e}`);
    });
    expect(wrong, "holdVaultLock('exclusive', ...) for the file, or wrap the step in vaultExclusively(...)").toEqual([]);
  });

  it('a spec that names a device or window for sharing an unlock holds it exclusive', () => {
    const wrong = specs.filter((f) => NAMES_JOINER.test(code(f)) && holdOf(code(f))?.mode !== 'exclusive');
    expect(wrong).toEqual([]);
  });

  it('a serial file holds it per file, any other file per test', () => {
    const wrong = users.filter((f) => {
      const src = code(f);
      return /mode:\s*'serial'/.test(src) !== (holdOf(src)?.scope === 'file');
    });
    expect(wrong).toEqual([]);
  });

  it('the vault lock comes before the approvals lock, never inside it', () => {
    const both = users.filter((f) => /\bholdApprovalsLock\(/.test(code(f)));
    expect(both.length).toBeGreaterThan(0);
    const wrong = both.flatMap((f) => {
      const src = code(f);
      const vault = holdOf(src)!;
      const approvals = /\bholdApprovalsLock\('(file|test)'/.exec(src);
      const why: string[] = [];
      if (src.indexOf('holdVaultLock(') > src.indexOf('holdApprovalsLock(')) why.push('holdVaultLock is called after holdApprovalsLock');
      if (approvals?.[1] === 'file' && vault.scope !== 'file') why.push('approvals per file but the vault per test');
      // A step alone on the vault would take the vault lock while this worker holds approvals.
      if (/\bvaultExclusively\(/.test(src)) why.push('vaultExclusively in a spec that holds the approvals lock');
      return why.map((w) => `${f}: ${w}`);
    });
    expect(wrong).toEqual([]);
  });
});
