/**
 * Ratchet: a glob pathspec written inside a block comment silently ENDS it.
 *
 * `*` followed by `/` is the comment terminator, so a comment that documents a
 * pathspec like `* / rel` (written without the space) closes the block early. The
 * rest of the prose then parses as code and the file fails to build — with an
 * error pointing at a line that looks fine, several lines below the real cause.
 *
 * This cost two separate debugging rounds while writing the path resolver, both
 * times in a comment explaining a `git ls-files` pathspec. It is invisible on
 * review, the error message is misleading, and the fix is trivial once you know.
 * So: a test, not a memo.
 *
 * Scoped to source files rather than the whole tree because a `.md` snippet
 * containing the sequence is harmless.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

/** Tracked .ts/.tsx/.js/.mjs/.cjs files, via git so ignored output is skipped. */
function sourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs'], {
    cwd: REPO, encoding: 'utf-8', maxBuffer: 32 << 20,
  });
  return out.split('\0').filter(Boolean);
}

/**
 * Find lines where a glob inside comment PROSE accidentally closed the block.
 *
 * The signature is specific, which is what keeps this from flagging ordinary code:
 * the line is a continuation of a doc block (starts with `*`), and after the `*​/`
 * there is still prose rather than end-of-line. A legitimate inline comment
 * (`/* note *​/ code`) never starts with `*`, and a normal doc-block terminator has
 * nothing after it.
 */
function prematureTerminators(src: string): number[] {
  const lines = src.split('\n');
  const bad: number[] = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inBlock) {
      const open = line.indexOf('/*');
      if (open !== -1 && line.indexOf('*/', open + 2) === -1) inBlock = true;
      continue;
    }
    const close = line.indexOf('*/');
    if (close === -1) continue;
    inBlock = false;
    // Only a DOC-BLOCK continuation line can hold this trap.
    if (!line.trimStart().startsWith('*')) continue;
    const after = line.slice(close + 2);
    // Prose after the terminator = the block ended somewhere unintended. A JSX
    // comment close (`*/}`) and a bare terminator are both fine.
    if (/[A-Za-z0-9]/.test(after)) bad.push(i + 1);
  }
  return bad;
}

describe('block comments are not terminated by a glob pathspec', () => {
  it('holds across every tracked source file', async () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      let src: string;
      try {
        src = await fs.readFile(path.join(REPO, rel), 'utf-8');
      } catch {
        continue; // deleted but still indexed
      }
      if (!src.includes('*/')) continue;
      for (const line of prematureTerminators(src)) {
        offenders.push(`${rel}:${line}`);
      }
    }
    // Any hit is either a real early-terminated comment or code sharing a line
    // with a comment close — both worth rewriting, since both read as a trap.
    expect(offenders).toEqual([]);
  });

  it('the scanner actually catches the shape it exists for', () => {
    // The exact mistake, twice made: documenting a pathspec inside a comment.
    const trap = [
      '/**',
      ' * Search with a */rel pathspec.',   // ← closes here, prose becomes code
      ' */',
      'export const x = 1;',
    ].join('\n');
    expect(prematureTerminators(trap)).toEqual([2]);

    const fine = [
      '/**',
      ' * Search with a wildcard-prefixed pathspec.',
      ' */',
      'export const x = 1;',
    ].join('\n');
    expect(prematureTerminators(fine)).toEqual([]);
  });
});
