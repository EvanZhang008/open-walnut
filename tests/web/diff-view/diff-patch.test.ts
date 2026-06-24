/**
 * REGRESSION GATE for the session "Changed" view diff pipeline.
 *
 * The bug this guards: `diff`'s createPatch emits an `Index:/===/--- name`
 * unidiff preamble, but react-diff-view's parser only normalizes `diff --git`
 * headers — on anything else it throws `Cannot read properties of undefined
 * (reading 'changes')` SYNCHRONOUSLY inside parseDiff. In the component that
 * throw escaped a useMemo with no error boundary and blanked the ENTIRE page.
 *
 * Why this test catches what the others missed: the route/E2E tests only asserted
 * the backend `/changes` JSON. They never ran the FRONTEND parse where the crash
 * lived. This drives the exact production pipeline (`buildFileData` →
 * createPatch → parseDiff) with the real libraries from web/node_modules, so a
 * reverted fix fails here loudly instead of in the browser.
 *
 * Runs under vitest.diff-view.config.ts (root: web/) so `diff`/`react-diff-view`
 * and the `@/` alias resolve exactly like the live app. No DOM needed — the
 * pipeline under test is pure string→data.
 */
import { describe, it, expect } from 'vitest';
import { tokenize, markEdits } from 'react-diff-view';
import { buildFileData, toGitStylePatch } from '@/components/sessions/diffPatch';
import { buildSelectionPrefill, buildCommentMessage, buildReviewMessage } from '@/components/sessions/diffPrefill';
import type { SessionFileChange } from '@/api/session-changes';

function change(partial: Partial<SessionFileChange> & { before: string; after: string; relPath: string }): SessionFileChange {
  return {
    filePath: '/abs/' + partial.relPath,
    relPath: partial.relPath,
    before: partial.before,
    after: partial.after,
    status: partial.status ?? 'modified',
    ops: partial.ops ?? [],
    partial: partial.partial ?? false,
  };
}

/** The real corpus the seeded UI session produces (modify / add-lines / edit / json). */
const CASES: Array<{ name: string; before: string; after: string; adds: number; dels: number }> = [
  {
    name: 'modify — interface gets new lines',
    before: 'export interface Tool {\n  name: string;\n}\n',
    after: 'export interface Tool {\n  name: string;\n  toolName: string; // added\n  changedFiles?: string[];\n}\n',
    adds: 2, dels: 0,
  },
  {
    name: 'add — Write into a previously empty file',
    before: '',
    after: 'export const NEW = true;\nexport const KEEP = 1;\n',
    adds: 2, dels: 0,
  },
  {
    name: 'edit — single-line value change',
    before: 'export const widget = "v1";\nexport const shared = true;\n',
    after: 'export const widget = "v2";\nexport const shared = true;\n',
    adds: 1, dels: 1,
  },
  {
    name: 'json — version bump',
    before: '{"version": 1}\n',
    after: '{"version": 2}\n',
    adds: 1, dels: 1,
  },
];

describe('toGitStylePatch', () => {
  it('emits a diff --git header (NOT createPatch\'s Index:/=== preamble)', () => {
    const patch = toGitStylePatch('src/x.ts', 'a\n', 'b\n');
    expect(patch).not.toBeNull();
    expect(patch!.startsWith('diff --git a/src/x.ts b/src/x.ts')).toBe(true);
    expect(patch).not.toContain('Index:');
    expect(patch).not.toContain('===================');
    expect(patch).toContain('@@');
  });

  it('returns null when there is no hunk (identical content)', () => {
    expect(toGitStylePatch('src/x.ts', 'same\n', 'same\n')).toBeNull();
  });
});

describe('buildFileData — the pipeline that blanked the page', () => {
  for (const c of CASES) {
    it(`parses + tokenizes without throwing: ${c.name}`, () => {
      const file = buildFileData(change({ relPath: 'src/f.ts', before: c.before, after: c.after }));
      // Before the fix this line never executed — parseDiff threw first.
      expect(file).not.toBeNull();
      expect(file!.hunks.length).toBeGreaterThan(0);

      let adds = 0, dels = 0;
      for (const h of file!.hunks) {
        for (const ch of h.changes) {
          if (ch.type === 'insert') adds++;
          else if (ch.type === 'delete') dels++;
        }
      }
      expect(adds).toBe(c.adds);
      expect(dels).toBe(c.dels);

      // The word-level highlighter (markEdits + tokenize) must also survive — it
      // walks file.hunks[*].changes, the same shape parseDiff must produce intact.
      const tokens = tokenize(file!.hunks, { highlight: false, enhancers: [markEdits(file!.hunks, { type: 'block' })] });
      expect(tokens.new.length).toBeGreaterThan(0);
    });
  }

  it('returns null (no throw) for identical before/after', () => {
    expect(buildFileData(change({ relPath: 'src/f.ts', before: 'x\n', after: 'x\n' }))).toBeNull();
  });

  it('handles a file path with spaces and unicode without throwing', () => {
    const file = buildFileData(change({ relPath: 'src/名前 file.ts', before: 'old\n', after: 'new\n' }));
    expect(file).not.toBeNull();
    expect(file!.hunks.length).toBe(1);
  });
});

describe('buildSelectionPrefill — text that lands in the existing chat input', () => {
  it('single-line selection → inline backticks + trailing colon-space for the cursor', () => {
    const out = buildSelectionPrefill('src/lib.ts', 42, 'return 2;');
    expect(out).toBe('About src/lib.ts:42 `return 2;`: ');
    // Trailing "space" matters: the cursor sits after it so the user just types.
    expect(out.endsWith(': ')).toBe(true);
  });

  it('omits the line number when none is known', () => {
    expect(buildSelectionPrefill('src/lib.ts', undefined, 'x')).toBe('About src/lib.ts `x`: ');
  });

  it('multi-line selection → fenced code block (not inline backticks)', () => {
    const out = buildSelectionPrefill('a.ts', 3, 'line1\nline2');
    expect(out).toContain('```');
    expect(out).toContain('line1\nline2');
    expect(out.startsWith('About a.ts:3 ')).toBe(true);
  });

  it('trims surrounding whitespace from the selected code', () => {
    expect(buildSelectionPrefill('a.ts', 1, '  spaced  ')).toBe('About a.ts:1 `spaced`: ');
  });
});

describe('buildCommentMessage — GitHub-style line comment sent to the agent', () => {
  it('single line → "Re: loc `code`\\n\\ncomment" (the exact shape sent over session:send)', () => {
    const out = buildCommentMessage('src/x.ts:L10', 'const p = payload as T;', 'Add a guard here.');
    expect(out).toBe('Re: src/x.ts:L10 `const p = payload as T;`\n\nAdd a guard here.');
  });

  it('multi-line code → fenced block, not inline backticks', () => {
    const out = buildCommentMessage('a.ts:L1-L2', 'line1\nline2', 'why two lines?');
    expect(out).toContain('```\nline1\nline2\n```');
    expect(out.startsWith('Re: a.ts:L1-L2')).toBe(true);
    expect(out.endsWith('why two lines?')).toBe(true);
  });

  it('empty code → no quote block, just the located note', () => {
    expect(buildCommentMessage('a.ts:L5', '   ', 'general note')).toBe('Re: a.ts:L5\n\ngeneral note');
  });

  it('separates the comment from the reference with a blank line (so the agent sees a clear note)', () => {
    const out = buildCommentMessage('a.ts:L5', 'x', 'do it');
    expect(out).toContain('\n\n');
    // The reference and the comment must not run together on one line.
    expect(out.split('\n\n')[1]).toBe('do it');
  });
});

describe('buildReviewMessage — the BULK "Submit review" batch (the GitHub PR-review model)', () => {
  it('empty batch → empty string (caller gates on this; nothing is sent)', () => {
    expect(buildReviewMessage([])).toBe('');
  });

  it('single comment → IDENTICAL to buildCommentMessage (a 1-comment review reads the same)', () => {
    const one = { loc: 'src/x.ts:L10', code: 'const p = payload as T;', comment: 'Add a guard here.' };
    expect(buildReviewMessage([one])).toBe(buildCommentMessage(one.loc, one.code, one.comment));
  });

  it('multiple comments → a numbered list under a count header (one message, sent together)', () => {
    const out = buildReviewMessage([
      { loc: 'a.ts:L1', code: 'foo()', comment: 'rename this' },
      { loc: 'b.ts:L9', code: 'bar()', comment: 'guard for null' },
    ]);
    expect(out.startsWith('Code review — 2 comments:')).toBe(true);
    expect(out).toContain('1. Re: a.ts:L1 `foo()`');
    expect(out).toContain('rename this');
    expect(out).toContain('2. Re: b.ts:L9 `bar()`');
    expect(out).toContain('guard for null');
  });

  it('multi-line code in a batch entry → fenced block', () => {
    const out = buildReviewMessage([
      { loc: 'a.ts:L1', code: 'x', comment: 'c1' },
      { loc: 'b.ts:L1-L2', code: 'line1\nline2', comment: 'c2' },
    ]);
    expect(out).toContain('```\nline1\nline2\n```');
  });

  it('empty code in a batch entry → no quote, just the located note', () => {
    const out = buildReviewMessage([
      { loc: 'a.ts:L1', code: '', comment: 'first' },
      { loc: 'b.ts:L2', code: '  ', comment: 'second' },
    ]);
    expect(out).toContain('1. Re: a.ts:L1\nfirst');
    expect(out).toContain('2. Re: b.ts:L2\nsecond');
  });
});
