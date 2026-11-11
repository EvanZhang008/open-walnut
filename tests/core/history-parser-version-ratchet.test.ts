/**
 * The parse version a ready view carries (src/core/history-parser-version.ts) is the hash of the
 * parser's and the ready-view builder's source. A host's daemon can run an older build for hours;
 * the server keeps its view only when the versions match (history-ready-view.ts), so a stale
 * constant would let an older parser's rows pass as this server's. This fails until the file is
 * written again: `bun scripts/history-parser-version.mjs --write`.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain .mjs script, no types
import { parserClosure, parserVersion, writtenVersion, ROOTS, LOCATE_ONLY } from '../../scripts/history-parser-version.mjs';
import { HISTORY_PARSER_VERSION } from '../../src/core/history-parser-version.js';

describe('history parser version', () => {
  it('is the hash of the source it names', () => {
    expect(writtenVersion()).toBe(HISTORY_PARSER_VERSION);
    expect(parserVersion()).toBe(HISTORY_PARSER_VERSION);
  });

  it('covers the parser, the builder, the rewind dead set and everything they load', () => {
    const files = parserClosure() as string[];
    for (const f of [...ROOTS, 'src/providers/transcript-rewind-core.ts', 'src/core/transcript-chain.ts',
      'src/core/sessions/legacy-hint-lines.ts', 'src/lib/history-turn-window.ts']) expect(files).toContain(f);
    expect(files).not.toContain('src/core/history-parser-version.ts');
    for (const f of LOCATE_ONLY as Set<string>) expect(files).not.toContain(f);
  });

  it('moves with a one-byte edit to any file it covers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-version-'));
    try {
      for (const f of parserClosure() as string[]) {
        fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
        fs.copyFileSync(f, path.join(root, f));
      }
      const before = parserVersion(root);
      expect(before).toBe(HISTORY_PARSER_VERSION);
      fs.appendFileSync(path.join(root, 'src/lib/walnut-added.ts'), ' ');
      expect(parserVersion(root)).not.toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
