/**
 * REGRESSION GATE for syntax highlighting in the session "Changed" view.
 *
 * The bug this guards: react-diff-view 3.x was built against refractor v2,
 * whose `highlight()` returned an ARRAY of hast nodes — it does
 * `createRoot(refractor.highlight(...))`, treating the result as the children
 * array. refractor v4 (what we install) instead returns a hast Root object
 * `{ type: 'root', children: [...] }`. Passed raw, react-diff-view wraps the
 * Root in another root and tries to iterate a non-iterable → highlighting
 * SILENTLY no-ops and every line renders as plain text (0 token spans).
 *
 * The fix lives in `@/components/sessions/diffHighlight.ts`: `diffRefractor`
 * unwraps to `.children` so the v4 grammar output matches the v2-era shape
 * react-diff-view expects. If that shim regresses, `tokenize({highlight:true})`
 * produces no Prism token nodes and these assertions fail loudly here instead
 * of shipping a colorless diff.
 *
 * Why a unit test (not just the live Playwright check): the browser run proves
 * it works today, but this drives the EXACT production pipeline (parseDiff →
 * tokenize with the real `diffRefractor` shim + the real `react-diff-view` and
 * `refractor` from web/node_modules) so a reverted shim fails in CI.
 *
 * Runs under vitest.diff-view.config.ts (web-rooted aliases, no DOM needed —
 * tokenize is pure data→data).
 */
import { describe, it, expect } from 'vitest';
import { tokenize, markEdits, parseDiff } from 'react-diff-view';
import { languageForPath, diffRefractor } from '@/components/sessions/diffHighlight';

/** Collect every Prism token className present in a tokenize() result tree. */
function collectTokenClasses(tokens: ReturnType<typeof tokenize>): Set<string> {
  const classes = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { properties?: { className?: unknown }; className?: unknown; children?: unknown[] };
    const cn = n.properties?.className ?? n.className;
    if (cn) ([] as unknown[]).concat(cn).forEach((c) => typeof c === 'string' && classes.add(c));
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  tokens.old.flat().forEach(walk);
  tokens.new.flat().forEach(walk);
  return classes;
}

/** A real git-style unified diff (has the `diff --git` header gitdiffParser needs). */
function gitPatch(oldPath: string, newPath: string, body: string): string {
  return `diff --git a/${oldPath} b/${newPath}\nindex 1111111..2222222 100644\n--- a/${oldPath}\n+++ b/${newPath}\n${body}`;
}

describe('diffHighlight: language mapping', () => {
  it('maps common source extensions to refractor languages', () => {
    expect(languageForPath('src/core/session-git-diff.ts')).toBe('typescript');
    expect(languageForPath('web/src/App.tsx')).toBe('tsx');
    expect(languageForPath('scripts/seed.mjs')).toBe('javascript');
    expect(languageForPath('a/b/Main.java')).toBe('java');
    expect(languageForPath('run.py')).toBe('python');
    expect(languageForPath('main.go')).toBe('go');
    expect(languageForPath('lib.rs')).toBe('rust');
    expect(languageForPath('style.css')).toBe('css');
    expect(languageForPath('data.json')).toBe('json');
    expect(languageForPath('config.yaml')).toBe('yaml');
    expect(languageForPath('README.md')).toBe('markdown');
  });

  it('returns undefined for unknown / extensionless paths (→ caller skips highlight)', () => {
    expect(languageForPath('Makefile')).toBeUndefined();
    expect(languageForPath('LICENSE')).toBeUndefined();
    expect(languageForPath('weird.zzz')).toBeUndefined();
    expect(languageForPath('noext')).toBeUndefined();
  });

  it('registers tsx/jsx onto the common bundle (omitted by default)', () => {
    // tsx is NOT in the refractor "common" bundle; diffHighlight registers it.
    // languageForPath only returns 'tsx' if refractor.registered('tsx') is true.
    expect(languageForPath('Component.tsx')).toBe('tsx');
    expect(languageForPath('legacy.jsx')).toBe('jsx');
  });
});

describe('diffHighlight: refractor v4→v3 shim drives real token spans', () => {
  it('produces Prism token classes for a TypeScript diff (regression: v4 Root object)', () => {
    const patch = gitPatch('a.ts', 'a.ts', [
      '@@ -1,2 +1,2 @@',
      '-const x = 1;',
      '+const x = 2; // changed',
      ' function foo() { return x; }',
    ].join('\n') + '\n');
    const [file] = parseDiff(patch);
    const hunks = file!.hunks;

    const tokens = tokenize(hunks, {
      highlight: true,
      refractor: diffRefractor,
      language: 'typescript',
      enhancers: [markEdits(hunks, { type: 'block' })],
    });

    const classes = collectTokenClasses(tokens);
    // If the shim regressed (returning the Root object), tokenize emits NO token
    // nodes → this set is empty. With the shim, real Prism classes appear.
    expect(classes.has('token')).toBe(true);
    expect(classes.has('keyword')).toBe(true);
    expect(classes.has('comment')).toBe(true);
  });

  it('highlights tsx (the registered-on-top language)', () => {
    const patch = gitPatch('C.tsx', 'C.tsx', [
      '@@ -1 +1 @@',
      '-const E = () => <div>hi</div>;',
      '+const E = () => <div className="x">hi</div>;',
    ].join('\n') + '\n');
    const [file] = parseDiff(patch);
    const tokens = tokenize(file!.hunks, {
      highlight: true,
      refractor: diffRefractor,
      language: 'tsx',
    });
    const classes = collectTokenClasses(tokens);
    expect(classes.has('token')).toBe(true);
    // JSX/TSX grammar emits tag/attr tokens for the markup.
    expect(classes.size).toBeGreaterThan(1);
  });

  it('diffRefractor.highlight returns an ARRAY (not a hast Root) — the shim contract', () => {
    const out = diffRefractor.highlight('const x = 1;', 'typescript');
    // The whole point of the shim: react-diff-view does createRoot(out), so out
    // must be the children array, NOT { type:'root', children }.
    expect(Array.isArray(out)).toBe(true);
    expect((out as unknown as { type?: string }).type).toBeUndefined();
  });
});
