/**
 * GUARD: every place that shows a question's number shows its thread id (2026-11-03,
 * the user: each question's id and name "must match"; the review found badges reading
 * the flat number, so after a nested 1.1 a new top-level question read Q3 while its
 * tag said thread="2").
 *
 * The label is `questionLabels` (web/src/utils/question-tag.ts): the thread id, else
 * the number of a question from before ids. This test finds, from the source, every
 * component that draws a question badge (`thread-map-num`) or names a question in an
 * aria label, and fails when its `number` is typed as a number; and it fails on any
 * read of `questionNumbers` outside the `[Qn]` tag reader.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const WEB = join(ROOT, 'web', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(WEB).map((p) => ({ rel: relative(ROOT, p), src: readFileSync(p, 'utf8') }));

/** Where the label a badge shows is computed. */
const LABEL_SOURCES = [
  'web/src/components/sessions/SessionChatHistory.tsx',
  'web/src/hooks/useSessionThreads.ts',
  'web/src/utils/thread-tree-rows.ts',
  'web/src/utils/file-thread.ts',
];

describe('guard: a question badge shows its thread id', () => {
  it('finds the badges (turn label, comment card, map row, review card, composer pill)', () => {
    const badges = files.filter((f) => /className="thread-map-num"/.test(f.src)).map((f) => f.rel).sort();
    expect(badges).toEqual([
      'web/src/components/sessions/ComposerThreadPill.tsx',
      'web/src/components/sessions/ThreadCommentCard.tsx',
      'web/src/components/sessions/ThreadMap.tsx',
      'web/src/components/sessions/ThreadReviewSidebar.tsx',
      'web/src/components/sessions/ThreadTurnLabel.tsx',
    ]);
  });

  it('no badge, row or entry types its number as a number', () => {
    const shown = [
      ...files.filter((f) => /thread-map-num|`Question \$\{/.test(f.src)),
      ...files.filter((f) => LABEL_SOURCES.includes(f.rel)),
      ...files.filter((f) => f.rel === 'web/src/components/sessions/useThreadReviewPane.tsx'),
    ];
    for (const f of shown) {
      for (const m of f.src.matchAll(/\bnumbers?\??:\s*([^;,\n]+)/g)) {
        expect(m[1], `${f.rel}: ${m[0]}`).not.toMatch(/\bnumber\b(?!s)/);
      }
    }
  });

  it('the labels come from questionLabels; questionNumbers is only the `[Qn]` reader\'s', () => {
    for (const rel of LABEL_SOURCES) {
      const src = files.find((f) => f.rel === rel)!.src;
      expect(src, rel).toMatch(/\bquestionLabels\(/);
    }
    for (const f of files) {
      if (f.rel === 'web/src/utils/question-tag.ts') continue;
      const reads = [...f.src.matchAll(/\bquestionNumbers\(/g)].length;
      if (f.rel === 'web/src/components/sessions/SessionChatHistory.tsx') {
        // The one read: the old tag's number to its question.
        expect(reads, f.rel).toBe(1);
        expect(f.src).toMatch(/keysBySeq\(questionNumbers\(threadTree, threadsApi\.metaIndex\)\)/);
      } else {
        expect(reads, `${f.rel} reads questionNumbers (show questionLabels instead)`).toBe(0);
      }
    }
  });
});
