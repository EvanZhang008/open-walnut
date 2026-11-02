import { describe, it, expect } from 'vitest';
import { IN_PLACE_WRITERS, parseBashFileOps } from '../../src/core/bash-file-ops.js';

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

  it('parses `>>` append redirection as a change in place of its target', () => {
    expect(parseBashFileOps('cat a >> log.txt', CWD)).toEqual([{ kind: 'modify', path: `${CWD}/log.txt` }]);
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

/**
 * Commands that rewrite the files they name, in place (2026-11-01: a `sed -i` in a shared
 * checkout was not counted as the session's change, so a task move left it behind). One
 * case per IN_PLACE_WRITERS entry: a writer added there without a case here fails.
 */
const WRITER_CASES: Record<string, Array<[string, string[]]>> = {
  sed: [
    ["sed -i 's/a/b/' src/x.ts", ['src/x.ts']],
    ["sed -i.bak -e 's/a/b/' -e 's/c/d/' a.txt b.txt", ['a.txt', 'b.txt']],
    ["sed -i '' 's/a/b/' mac.txt", ['mac.txt']],
    ["sed -Ei 's/(a)/b/' e.txt", ['e.txt']],
    ["sed --in-place=.orig -n 'p' long.txt", ['long.txt']],
    ["sed -f script.sed -i f.txt", ['f.txt']],
    ["sed -n 's/a/b/p' read-only.txt", []],
  ],
  gsed: [["gsed -i 's/a/b/' g.txt", ['g.txt']]],
  perl: [
    ["perl -pi -e 's/a/b/g' p.txt q.txt", ['p.txt', 'q.txt']],
    ["perl -i.bak -pe 's/a/b/' r.txt", ['r.txt']],
    ["perl -ne 'print' read-only.txt", []],
  ],
  ruby: [["ruby -i -pe 'gsub(/a/, %q(b))' rb.txt", ['rb.txt']]],
  tee: [["echo x | tee -a out.log", ['out.log']], ['echo x | tee one.txt two.txt', ['one.txt', 'two.txt']]],
  truncate: [['truncate -s 0 big.log', ['big.log']]],
  dos2unix: [['dos2unix crlf.txt', ['crlf.txt']], ['dos2unix -n in.txt out.txt', ['out.txt']]],
  unix2dos: [['unix2dos lf.txt', ['lf.txt']]],
  prettier: [
    ['npx prettier --write src/a.ts src/b.tsx', ['src/a.ts', 'src/b.tsx']],
    ['bun x prettier --config .prettierrc -w c.ts', ['c.ts']],
    ['prettier --check src/a.ts', []],
  ],
  eslint: [
    ['./node_modules/.bin/eslint --fix --ext .ts src/x.ts', ['src/x.ts']],
    ['eslint --fix --ignore-path .gitignore --rulesdir rules src/y.ts', ['src/y.ts']],
    ['eslint src/x.ts', []],
  ],
  biome: [
    ['bunx biome format --write web/a.tsx', ['web/a.tsx']],
    ['biome check --write --config-path biome.json b.ts', ['b.ts']],
    ['biome format c.ts', []],
  ],
  gofmt: [['gofmt -w main.go', ['main.go']], ['gofmt -l main.go', []]],
  goimports: [['goimports -w util.go', ['util.go']]],
  black: [['black app.py', ['app.py']], ['black --check app.py', []]],
  isort: [['isort --settings-path cfg.toml app.py', ['app.py']], ['isort --check-only app.py', []], ['isort --profile black -c app.py', []]],
  ruff: [
    ['uv run ruff format m.py', ['m.py']],
    ['ruff check --fix --config pyproject.toml n.py', ['n.py']],
    ['ruff check n.py', []],
    ['ruff check --fix --diff n.py', []],
  ],
  rustfmt: [['rustfmt --edition 2021 src/main.rs', ['src/main.rs']], ['rustfmt --check src/main.rs', []], ['rustfmt --emit stdout src/main.rs', []]],
  'clang-format': [['clang-format -i a.cc', ['a.cc']], ['clang-format a.cc', []]],
  autopep8: [['autopep8 --in-place old.py', ['old.py']]],
  yapf: [['yapf -i y.py', ['y.py']]],
};

describe('parseBashFileOps: commands that rewrite files in place', () => {
  it('every known writer has its cases here', () => {
    expect(Object.keys(IN_PLACE_WRITERS).filter((k) => !WRITER_CASES[k])).toEqual([]);
  });

  for (const [name, cases] of Object.entries(WRITER_CASES)) {
    it(`${name}: the files it rewrites are modify ops, a read-only use is none`, () => {
      for (const [command, files] of cases) {
        expect(parseBashFileOps(command, CWD), command).toEqual(files.map((f) => ({ kind: 'modify', path: `${CWD}/${f}` })));
      }
    });
  }

  it('follows cd, skips a glob operand, and never takes a prototype name for a writer', () => {
    expect(parseBashFileOps("cd sub && sed -i 's/a/b/' x.txt *.md", CWD)).toEqual([{ kind: 'modify', path: `${CWD}/sub/x.txt` }]);
    expect(parseBashFileOps('toString a.txt', CWD)).toEqual([]);
    expect(parseBashFileOps('constructor -i a.txt', CWD)).toEqual([]);
  });
});
