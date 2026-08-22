import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Boundary gate: src/lib/hybrid-search/ is written as a standalone library
 * (publishable later by copying the directory). It must never import walnut
 * code — no logging, no constants, no event bus, no core types. Config comes
 * in through createSearchIndex options instead.
 */
const LIB_DIR = path.resolve(__dirname, '../../src/lib/hybrid-search');

const ALLOWED = [
  /^node:/,
  /^better-sqlite3$/,
  /^@huggingface\/transformers$/,
  /^\.\/[^/]+\.js$/, // same-directory siblings only
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

describe('hybrid-search library boundary', () => {
  const files = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.ts'));

  it('has library source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} imports nothing outside the allowlist`, () => {
      const source = fs.readFileSync(path.join(LIB_DIR, file), 'utf8');
      const specifiers: string[] = [];
      for (const match of source.matchAll(IMPORT_RE)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (spec) specifiers.push(spec);
      }
      const violations = specifiers.filter(
        (spec) => !ALLOWED.some((re) => re.test(spec)),
      );
      expect(violations, `disallowed imports in ${file}`).toEqual([]);
    });
  }
});
