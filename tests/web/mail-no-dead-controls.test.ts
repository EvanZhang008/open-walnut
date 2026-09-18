/**
 * A repo gate over the mail surfaces: no dead controls, no control bytes, no data that looks real.
 *
 * Not a unit test of anything, deliberately. Each rule here is a thing a screenshot or a review cannot
 * catch reliably, and each has already cost this repo something:
 *
 * - FLAGGED and VIPS are dead controls. `Flagged` appears in the flags of ZERO of the 3,990 cached
 *   messages on the machine this slice was designed against, and Walnut has no VIP concept at all, so a
 *   row for either is a button that can only ever answer "nothing". They look good in a mock of Apple
 *   Mail's sidebar, which is exactly why a gate rather than a decision is needed. The IMAP protocol
 *   constant `\Flagged` is still allowed: a provider mapping a real server flag is not a control.
 * - CONTROL BYTES in source, NUL above all. A test committed here once carried two raw NULs, one of them
 *   inside a regular expression, where it made an assertion true for every input: a green suite proving
 *   nothing. A raw NUL also makes grep treat the whole file as binary, so the next reader cannot search
 *   it. The cursor separator is a NUL, which is exactly why every file that needs one BUILDS it.
 * - FIXTURE DATA that looks real. This is a public repository, and a fixture is where somebody's actual
 *   folder names, subjects and addresses leak most easily, dressed up as realism. Addresses must sit in
 *   the RFC 2606 `.invalid` space and no mail-provider domain may appear at all.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');

/** The three trees this gate owns: the plugin, the console app, and the dense browser fixture. */
const TREES = [
  'src/integrations/mail',
  'web/src/apps/mail',
  'tests/e2e/browser/fixtures/mail-dense-provider',
];

const FIXTURE_TREE = 'tests/e2e/browser/fixtures/mail-dense-provider';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|css|mjs|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function files(tree: string): string[] {
  const dir = path.join(REPO, tree);
  expect(fs.existsSync(dir), `${tree} must exist for this gate to mean anything`).toBe(true);
  return walk(dir);
}

const ALL = TREES.flatMap((tree) => files(tree));

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function shortName(file: string): string {
  return path.relative(REPO, file);
}

describe('no dead controls (C41)', () => {
  it('scans a tree that actually has the files in it', () => {
    // A gate over an empty list passes forever. This is the assertion that the scan happened.
    expect(ALL.length).toBeGreaterThan(40);
    expect(ALL.some((file) => shortName(file).endsWith('mail-dense-provider/server.mjs'))).toBe(true);
  });

  it('mentions Flagged nowhere except as the IMAP protocol constant', () => {
    const offenders: string[] = [];
    for (const file of ALL) {
      // A line carrying the escaped protocol literal is dropped whole, because translating a real
      // server flag into a word for an agent is data, not a control (see `agent-format.ts`). Every
      // other mention is prose or a UI string, and there must be none of them.
      const lines = read(file).split('\n').filter((line) => !line.includes('\\\\Flagged'));
      const found = lines.filter((line) => /flagged/i.test(line));
      if (found.length > 0) offenders.push(`${shortName(file)}: ${found[0]!.trim().slice(0, 60)}`);
    }
    expect(offenders).toEqual([]);
  });

  it('has no VIP anything', () => {
    const offenders = ALL.filter((file) => /\bVIPs?\b/i.test(read(file))).map(shortName);
    expect(offenders).toEqual([]);
  });
});

describe('no control bytes in source (C41)', () => {
  it('carries no NUL and no other stray control character', () => {
    const offenders: string[] = [];
    for (const file of ALL) {
      const text = read(file);
      for (let at = 0; at < text.length; at += 1) {
        const code = text.charCodeAt(at);
        const allowed = code === 9 || code === 10 || code === 13;
        if ((code < 0x20 && !allowed) || code === 0x7f) {
          const line = text.slice(0, at).split('\n').length;
          offenders.push(`${shortName(file)}:${line} has 0x${code.toString(16)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('fixture data cannot look real (C41)', () => {
  const fixture = files(FIXTURE_TREE);

  it('addresses every message to the RFC 2606 invalid space', () => {
    const offenders: string[] = [];
    for (const file of fixture) {
      for (const match of read(file).matchAll(/[\w.+-]+@[\w.-]+/g)) {
        if (!match[0].endsWith('.invalid')) offenders.push(`${shortName(file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no real webmail host inside the fixture', () => {
    // The FIXTURE only. The product itself names these hosts on purpose (`setup-presets.ts` fills in the
    // servers for a real provider), and that is a feature. Inside canned data the same string means
    // somebody pasted from their own mailbox. Not a completeness claim: these are the hosts a
    // "realistic" fixture reaches for first.
    const hosts = [
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com',
      'icloud.com', 'me.com', 'protonmail.com', 'proton.me', 'fastmail.com', 'zoho.com',
      'aol.com', 'gmx.com', 'yandex.com', 'qq.com', '163.com', '126.com',
    ];
    const offenders: string[] = [];
    for (const file of fixture) {
      const text = read(file).toLowerCase();
      for (const host of hosts) if (text.includes(host)) offenders.push(`${shortName(file)}: ${host}`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps its folder names inside the invented set it declares', () => {
    // The fixture's own label list is the allowlist: a folder name that is not in it (and is not one of
    // the six role names) is a name that came from somewhere, and a public repository is the wrong
    // place to find out where.
    const source = read(path.join(REPO, FIXTURE_TREE, 'server.mjs'));
    const declared = /const LABELS = \[([\s\S]*?)\];/.exec(source);
    expect(declared, 'the dense fixture must declare its labels in one list').not.toBeNull();
    const labels = [...declared![1]!.matchAll(/'([^']+)'/g)].map((one) => one[1]!);
    expect(labels).toHaveLength(58);
    // Neutral shape: letters and spaces only, so nothing carries a person, a company or a project.
    for (const label of labels) expect(label, label).toMatch(/^[A-Za-z][A-Za-z ]{2,19}$/);
    expect(new Set(labels).size).toBe(58);
  });
});
