/**
 * Ratchet: no tracked source file may contain a literal NUL byte.
 *
 * This is a LEAK-GUARD test, not a style test. One NUL anywhere in a file makes git
 * classify the whole file as binary, and from then on `git diff` prints
 * "Binary files differ" instead of the changed lines. The three sensitive-content
 * scanners this repo relies on (the write-time agent hook, the staged pre-commit
 * scan, the pre-push scan) all read a diff or the file's text, so a NUL turns a file
 * into a hole that a banned term can pass through unnoticed. `grep` goes silent on
 * the file for the same reason, which is how this was found: a search for a symbol
 * that was plainly in the file returned nothing at all.
 *
 * It is easy to introduce by accident and impossible to see. The idiom is a composite
 * map key joined on an unlikely separator, and in an editor a raw control character
 * and the backslash-u escape that means the same thing look identical. Five committed
 * files had it before this test existed. The escape is exactly as correct at runtime,
 * so there is never a reason to prefer the raw byte.
 *
 * This file itself was the sixth: an early draft of THIS comment carried a raw NUL
 * where it meant to show the escape, and the test passed anyway, because `git
 * ls-files` lists TRACKED files and the new test was still untracked. Know the gap
 * that leaves: a brand-new file's first commit is the one moment nothing catches,
 * since the staged and pre-push scans both read a DIFF and a NUL is what makes that
 * diff binary. Only reading the file's bytes catches it then, which is the check to
 * run by hand before committing a new source file.
 *
 * Genuinely binary files (images, fonts, sqlite fixtures) are excluded by extension
 * rather than by sniffing, so a new binary type has to be added here deliberately.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');

/** Extensions that must be text. Everything else is ignored, so adding a new
 *  source language means adding it here to get the protection. */
const TEXT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts',
  '.swift', '.md', '.json', '.yaml', '.yml', '.css', '.html', '.sh', '.txt',
];

function trackedTextFiles(): string[] {
  // -z: NUL-delimited output, which is the only listing that survives a path with a
  // newline in it. Fitting, given the subject.
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  return out.toString('utf-8')
    .split('\0')
    .filter(Boolean)
    .filter((f) => TEXT_EXTENSIONS.includes(path.extname(f)));
}

describe('no literal NUL bytes in tracked source', () => {
  it('every tracked text file is really text', () => {
    const offenders: string[] = [];
    for (const file of trackedTextFiles()) {
      const full = path.join(REPO, file);
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(full);
      } catch {
        continue; // a file listed but absent (mid-rebase) is not this test's problem
      }
      const index = bytes.indexOf(0);
      if (index === -1) continue;
      // Point at the line, since the byte is invisible in an editor.
      const line = bytes.subarray(0, index).toString('utf-8').split('\n').length;
      offenders.push(`${file}:${line}`);
    }
    expect(
      offenders,
      'A literal NUL byte makes git treat the file as BINARY, which blinds every '
      + 'sensitive-content scanner and silences grep on that file. Write the '
      + 'separator as the escape sequence \\u0000 instead. Offenders:\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });
});
