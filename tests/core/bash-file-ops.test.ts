import { describe, it, expect } from 'vitest';
import { parseBashFileOps } from '../../src/core/bash-file-ops.js';

const CWD = '/home/u/repo';

describe('parseBashFileOps — renames (mv / git mv)', () => {
  it('parses a plain mv into a rename op with absolute from/to', () => {
    const ops = parseBashFileOps('mv old.md new.md', CWD);
    expect(ops).toEqual([{ kind: 'rename', from: `${CWD}/old.md`, path: `${CWD}/new.md` }]);
  });

  it('parses git mv', () => {
    const ops = parseBashFileOps('git mv src/a.ts src/b.ts', CWD);
    expect(ops).toEqual([{ kind: 'rename', from: `${CWD}/src/a.ts`, path: `${CWD}/src/b.ts` }]);
  });

  it('handles quoted paths with spaces', () => {
    const ops = parseBashFileOps('git mv "Areas/Career/Immigration H1b" "Projects/Immigration H1b"', CWD);
    expect(ops).toEqual([{ kind: 'rename', from: `${CWD}/Areas/Career/Immigration H1b`, path: `${CWD}/Projects/Immigration H1b` }]);
  });

  it('follows the `git mv ... || mv ...` fallback idiom (both statements → two renames of the same move)', () => {
    // The `||` split yields two statements; each is a valid rename. The engine
    // dedups by destination path (last op wins) — both point at the same dest.
    const ops = parseBashFileOps('git mv "a.md" "b.md" 2>/dev/null || mv "a.md" "b.md"', CWD);
    // 2>/dev/null contains no unsafe operand chars for the first stmt's operands;
    // both statements parse to the same rename.
    expect(ops.filter((o) => o.kind === 'rename').map((o) => o.path)).toEqual([`${CWD}/b.md`, `${CWD}/b.md`]);
  });

  it('tracks `cd` so a later relative mv resolves against the new cwd', () => {
    const ops = parseBashFileOps('cd /other/dir\nmv x.md y.md', CWD);
    expect(ops).toEqual([{ kind: 'rename', from: '/other/dir/x.md', path: '/other/dir/y.md' }]);
  });

  it('resolves absolute operands regardless of cwd', () => {
    const ops = parseBashFileOps('mv /abs/a /abs/b', undefined);
    expect(ops).toEqual([{ kind: 'rename', from: '/abs/a', path: '/abs/b' }]);
  });
});

describe('parseBashFileOps — deletes (rm / git rm)', () => {
  it('parses rm of a single file', () => {
    expect(parseBashFileOps('rm stale.ts', CWD)).toEqual([{ kind: 'delete', path: `${CWD}/stale.ts` }]);
  });

  it('parses rm with flags and multiple files', () => {
    const ops = parseBashFileOps('rm -f a.ts b.ts', CWD);
    expect(ops).toEqual([
      { kind: 'delete', path: `${CWD}/a.ts` },
      { kind: 'delete', path: `${CWD}/b.ts` },
    ]);
  });

  it('parses git rm', () => {
    expect(parseBashFileOps('git rm old.ts', CWD)).toEqual([{ kind: 'delete', path: `${CWD}/old.ts` }]);
  });
});

describe('parseBashFileOps — creates (touch / cp / redirection)', () => {
  it('parses touch', () => {
    expect(parseBashFileOps('touch new.ts', CWD)).toEqual([{ kind: 'create', path: `${CWD}/new.ts` }]);
  });

  it('parses cp destination as a create', () => {
    expect(parseBashFileOps('cp src.ts dst.ts', CWD)).toEqual([{ kind: 'create', path: `${CWD}/dst.ts` }]);
  });

  it('parses `>` redirection as a create of its target', () => {
    expect(parseBashFileOps('echo hi > out.md', CWD)).toEqual([{ kind: 'create', path: `${CWD}/out.md` }]);
  });

  it('parses `>>` append redirection as a create too', () => {
    expect(parseBashFileOps('cat a >> log.txt', CWD)).toEqual([{ kind: 'create', path: `${CWD}/log.txt` }]);
  });
});

describe('parseBashFileOps — conservative refusals (correctness over recall)', () => {
  it('skips a glob operand (ambiguous)', () => {
    expect(parseBashFileOps('rm *.ts', CWD)).toEqual([]);
    expect(parseBashFileOps('mv src/*.md dst/', CWD)).toEqual([]);
  });

  it('skips variable / command substitution', () => {
    expect(parseBashFileOps('mv $A $B', CWD)).toEqual([]);
    expect(parseBashFileOps('rm "$(ls)"', CWD)).toEqual([]);
  });

  it('skips an unexpanded tilde', () => {
    expect(parseBashFileOps('rm ~/tmp/x', CWD)).toEqual([]);
  });

  it('skips mv with >2 operands (the "into a directory" form is ambiguous without disk knowledge)', () => {
    expect(parseBashFileOps('mv a.ts b.ts destdir', CWD)).toEqual([]);
  });

  it('skips a relative operand when no cwd is known', () => {
    expect(parseBashFileOps('mv a b', undefined)).toEqual([]);
  });

  it('ignores non-file commands and comments', () => {
    expect(parseBashFileOps('# just a comment\nls -la\ngrep foo bar.ts', CWD)).toEqual([]);
    expect(parseBashFileOps('git commit -m "x"', CWD)).toEqual([]);
  });
});

describe('parseBashFileOps — multi-statement real-world command', () => {
  it('parses a cd + several git mv chained with newlines (the notes-reorg case)', () => {
    const command = [
      'cd /home/u/notes',
      '# move the stray file first',
      'git mv "Projects/Perm.md" "Areas/Career/PERM/Perm-old.md" 2>/dev/null || mv "Projects/Perm.md" "Areas/Career/PERM/Perm-old.md"',
      'git mv "Areas/Career/PERM" "Projects/PERM" 2>/dev/null || mv "Areas/Career/PERM" "Projects/PERM"',
      'echo "=== done ===" && ls Projects/',
    ].join('\n');
    const ops = parseBashFileOps(command, '/wherever');
    const renames = ops.filter((o) => o.kind === 'rename');
    // Both `git mv` lines (and their `|| mv` fallbacks) resolve against /home/u/notes.
    expect(renames.some((o) => o.from === '/home/u/notes/Projects/Perm.md' && o.path === '/home/u/notes/Areas/Career/PERM/Perm-old.md')).toBe(true);
    expect(renames.some((o) => o.from === '/home/u/notes/Areas/Career/PERM' && o.path === '/home/u/notes/Projects/PERM')).toBe(true);
  });
});
