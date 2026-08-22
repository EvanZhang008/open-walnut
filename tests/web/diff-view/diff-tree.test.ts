/**
 * Unit tests for the file-tree builder (web/src/components/sessions/diffTree.ts).
 *
 * The Changed view's left rail is built from the API's repo groups: repo →
 * nested folders → files. These assert the tree shape, single-child folder
 * compression (GitHub-style `a/b/c`), file/dir ordering, counts, and the
 * markdown-path detector that gates the "Rendered" toggle.
 *
 * Runs under vitest.diff-view.config.ts (web-rooted, for the `@/` alias).
 */
import { describe, it, expect } from 'vitest';
import { buildDiffTree, flattenFiles, allContainerIds, isMarkdownPath, shortRepoLabels } from '@/components/sessions/diffTree';
import type { SessionRepoGroup, SessionFileChange } from '@/api/session-changes';

function file(relPath: string, status: SessionFileChange['status'] = 'modified'): SessionFileChange {
  return { filePath: '/abs/' + relPath, relPath, before: 'a', after: 'b', status, ops: [], partial: false };
}

function group(label: string, kind: SessionRepoGroup['kind'], files: SessionFileChange[]): SessionRepoGroup {
  return { repoRoot: '/repo/' + label, label, kind, files };
}

describe('buildDiffTree', () => {
  it('nests files under their folders, repo at the top level', () => {
    const tree = buildDiffTree([
      group('walnut', 'cwd', [file('src/core/x.ts'), file('src/core/y.ts'), file('README.md')]),
    ]);
    expect(tree).toHaveLength(1);
    const repo = tree[0]!;
    expect(repo.kind).toBe('repo');
    expect(repo.label).toBe('walnut');
    expect(repo.fileCount).toBe(3);

    // children: a dir (src/core) then the root-level file (README.md) — dirs first.
    expect(repo.children[0]!.kind).toBe('dir');
    expect(repo.children[1]!.kind).toBe('file');
    const dir = repo.children[0]!;
    if (dir.kind !== 'dir') throw new Error('expected dir');
    expect(dir.name).toBe('src/core'); // single-child chain compressed
    expect(dir.children.map((c) => c.kind)).toEqual(['file', 'file']);
    expect(dir.fileCount).toBe(2);
  });

  it('compresses single-child folder chains GitHub-style', () => {
    const tree = buildDiffTree([group('r', 'cwd', [file('a/b/c/deep.ts')])]);
    const repo = tree[0]!;
    const dir = repo.children[0]!;
    if (dir.kind !== 'dir') throw new Error('expected dir');
    expect(dir.name).toBe('a/b/c');
    expect(dir.children).toHaveLength(1);
    expect(dir.children[0]!.kind).toBe('file');
  });

  it('does NOT compress a folder that also holds files', () => {
    const tree = buildDiffTree([group('r', 'cwd', [file('a/top.ts'), file('a/b/deep.ts')])]);
    const repo = tree[0]!;
    const dirA = repo.children.find((c) => c.kind === 'dir');
    if (!dirA || dirA.kind !== 'dir') throw new Error('expected dir a');
    expect(dirA.name).toBe('a'); // not "a/b" — `a` has its own file
    // a contains: dir b (first), then file top.ts
    expect(dirA.children[0]!.kind).toBe('dir');
    expect(dirA.children[1]!.kind).toBe('file');
  });

  it('orders dirs before files, each alphabetically', () => {
    const tree = buildDiffTree([group('r', 'cwd', [
      file('zeta.ts'), file('alpha.ts'), file('m/inside.ts'),
    ])]);
    const repo = tree[0]!;
    const kinds = repo.children.map((c) => c.kind);
    expect(kinds).toEqual(['dir', 'file', 'file']);
    expect(repo.children[1]!.kind === 'file' && repo.children[1]!.name).toBe('alpha.ts');
    expect(repo.children[2]!.kind === 'file' && repo.children[2]!.name).toBe('zeta.ts');
  });

  it('keeps multiple repos as separate top-level nodes', () => {
    const tree = buildDiffTree([
      group('walnut', 'cwd', [file('a.ts')]),
      group('vendor/widget', 'submodule', [file('index.ts')]),
      group('other-lib', 'other', [file('lib.ts')]),
    ]);
    expect(tree.map((r) => r.repoKind)).toEqual(['cwd', 'submodule', 'other']);
    expect(tree.map((r) => r.fileCount)).toEqual([1, 1, 1]);
  });

  it('gives each repo a name-only shortLabel while keeping the full label', () => {
    const deep = 'context/by-team/acme/gizmo/subparts/anvil/src/AnvilTests';
    const tree = buildDiffTree([group(deep, 'submodule', [file('a.ts')])]);
    expect(tree[0]!.shortLabel).toBe('AnvilTests');
    expect(tree[0]!.label).toBe(deep); // full path survives for the tooltip
  });
});

describe('shortRepoLabels', () => {
  it('keeps only the last segment', () => {
    expect(shortRepoLabels(['a/b/c/Widget', 'Solo'])).toEqual(['Widget', 'Solo']);
  });

  it('deepens ONLY the colliding labels until they differ', () => {
    expect(shortRepoLabels([
      'x/one/src/Widget',
      'x/two/src/Widget',
      'x/three/src/Other',
    ])).toEqual(['one/src/Widget', 'two/src/Widget', 'Other']);
  });

  it('keeps deepening past a second collision', () => {
    // Both end in `one/src/Widget`, so one more segment is needed to separate them.
    expect(shortRepoLabels(['a/one/src/Widget', 'b/one/src/Widget']))
      .toEqual(['a/one/src/Widget', 'b/one/src/Widget']);
  });

  it('terminates on genuinely identical paths instead of looping', () => {
    expect(shortRepoLabels(['same/path', 'same/path'])).toEqual(['same/path', 'same/path']);
  });

  it('survives odd labels (empty, trailing slash, no separator)', () => {
    expect(shortRepoLabels(['', 'a/b/', 'plain'])).toEqual(['', 'b', 'plain']);
  });

  it('flattenFiles returns every file leaf in tree order', () => {
    const tree = buildDiffTree([group('r', 'cwd', [file('src/a.ts'), file('src/b.ts'), file('top.ts')])]);
    const files = flattenFiles(tree);
    expect(files.map((f) => f.name)).toEqual(['a.ts', 'b.ts', 'top.ts']);
  });

  it('allContainerIds lists repo + every dir (for expand-all)', () => {
    const tree = buildDiffTree([group('r', 'cwd', [file('a/b/c.ts')])]);
    const ids = allContainerIds(tree);
    // repo root + the compressed dir
    expect(ids.length).toBe(2);
    expect(ids).toContain('/repo/r');
  });
});

describe('isMarkdownPath', () => {
  it('matches .md / .markdown / .mdx (case-insensitive)', () => {
    expect(isMarkdownPath('docs/x.md')).toBe(true);
    expect(isMarkdownPath('R.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('a.mdx')).toBe(true);
  });
  it('rejects non-markdown', () => {
    expect(isMarkdownPath('src/x.ts')).toBe(false);
    expect(isMarkdownPath('readme.md.ts')).toBe(false);
  });
});
