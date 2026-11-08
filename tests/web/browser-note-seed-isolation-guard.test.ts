/**
 * A browser spec that seeds notes before each test either names them per test or runs its
 * tests one after another.
 *
 * The browser config runs every test of a file in parallel (fullyParallel), all against one
 * fixture server and one vault. 2026-11-08, the push gate: notes-find.spec.ts seeded the same
 * notes (one set per project) before every test, so a sibling test's seed rewrote the note under
 * a word the running test had just typed, and the test read the old text back. This reads every
 * spec that writes notes in a beforeEach and fails on one that does neither.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../e2e/browser');

const specs = fs.readdirSync(DIR).filter((f) => f.endsWith('.spec.ts'));
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');

/** The spec and the helper modules it imports from this folder. */
function withHelpers(f: string): string {
  const src = read(f);
  const local = [...src.matchAll(/from '\.\/([\w.-]+)'/g)]
    .map((m) => `${m[1].replace(/\.ts$/, '')}.ts`)
    .filter((h) => fs.existsSync(path.join(DIR, h)));
  return [src, ...local.map(read)].join('\n');
}

/** Each top-level beforeEach body (up to its closing `})` at the start of a line). */
function beforeEachBodies(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^test\.beforeEach\(/gm)) {
    const end = src.indexOf('\n})', m.index);
    out.push(src.slice(m.index, end === -1 ? undefined : end));
  }
  return out;
}

/** Writes notes (the notes content route, PUT) from a beforeEach. */
const seeders = specs.filter((f) => {
  const all = withHelpers(f);
  if (!/notes-v2\/content/.test(all) || !/\.put\(|method:\s*'PUT'/.test(all)) return false;
  return beforeEachBodies(read(f)).some((b) => /\b(put|seed\w*)\(/.test(b));
});

/** The file's tests run in order on one worker. */
const ordered = (src: string) => /describe\.configure\(\{[^}]*\bmode:\s*'(default|serial)'/.test(src);
/** The beforeEach hands the test's own identity to the seed. */
const perTest = (src: string) => beforeEachBodies(src)
  .every((b) => /\b(info|testInfo|test\.info\(\))\.(title|testId|repeatEachIndex|workerIndex|parallelIndex)\b/.test(b));

describe('browser note seeds stay with their test', () => {
  it('finds the specs it knows of (the matcher still matches)', () => {
    for (const known of ['notes-find.spec.ts', 'notes-search-preview.spec.ts', 'notes-format-toolbar.spec.ts']) {
      expect(seeders, known).toContain(known);
    }
  });

  it('every spec that seeds notes before each test names them per test or runs in order', () => {
    const shared = seeders.filter((f) => !ordered(read(f)) && !perTest(read(f)));
    expect(shared, "name the notes per test (info.title, repeatEachIndex) or add test.describe.configure({ mode: 'default' })").toEqual([]);
  });
});
