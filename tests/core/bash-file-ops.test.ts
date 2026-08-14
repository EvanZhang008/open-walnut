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
    const ops = parseBashFileOps('git mv "Areas/Career/Marina Renewal" "Projects/Marina Renewal"', CWD);
    expect(ops).toEqual([{ kind: 'rename', from: `${CWD}/Areas/Career/Marina Renewal`, path: `${CWD}/Projects/Marina Renewal` }]);
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

describe('parseBashFileOps — heredoc bodies and JS arrows are NOT file ops', () => {
  it('does not fabricate creates from a heredoc SCRIPT body (the "n/a)" incident)', () => {
    // Real incident (2026-08-13): a `cat > file <<'EOF' … EOF` Playwright script
    // contained `.catch(() => 'n/a')` and page.on handlers with `=>` — the body
    // was parsed as shell and `=> 'n/a')` became a created file named "n/a)".
    const command = [
      "cat > /tmp/pw-test.mjs <<'EOF'",
      "import { chromium } from 'playwright';",
      'const title = await page.locator(".t").textContent().catch(() => \'n/a\');',
      'page.on(\'pageerror\', (e) => errors.push(String(e)));',
      'if (n > 3) { console.log(n); }',
      'EOF',
      'node /tmp/pw-test.mjs',
    ].join('\n');
    const ops = parseBashFileOps(command, '/w');
    // The heredoc's stdout-redirect target IS a legitimate create…
    expect(ops).toEqual([{ kind: 'create', path: '/tmp/pw-test.mjs' }]);
  });

  it('heredoc WITHOUT a redirect produces nothing', () => {
    const command = [
      "python3 <<'PY'",
      "x = { 'a': 1 }",
      "print(x if x else 'n/a')",
      'PY',
    ].join('\n');
    expect(parseBashFileOps(command, '/w')).toEqual([]);
  });

  it('statements AFTER the heredoc terminator still parse', () => {
    const command = [
      "cat <<'EOF'",
      'body line with => arrow and n > 1 comparison',
      'EOF',
      'touch /tmp/after.txt',
    ].join('\n');
    expect(parseBashFileOps(command, '/w')).toEqual([{ kind: 'create', path: '/tmp/after.txt' }]);
  });

  it('a bare `=>` in an unquoted fragment is not a redirect', () => {
    expect(parseBashFileOps('node -e console.log([1].map((x)=>x))', '/w')).toEqual([]);
  });

  it('`>&2` fd duplication does not fabricate a file named `&2`', () => {
    expect(parseBashFileOps('echo "warn" >&2', '/w')).toEqual([]);
    // The real thing still works right next to it.
    expect(parseBashFileOps('echo hi > out.txt && echo "warn" >&2', '/w'))
      .toEqual([{ kind: 'create', path: '/w/out.txt' }]);
  });
});
