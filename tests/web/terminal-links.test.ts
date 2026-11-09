/**
 * Which words in terminal output are file links (web/src/components/sessions/terminal-links.ts).
 * A click opens the file in the session's Files view at its line, so the finder must catch
 * what compilers, test runners, git and tracebacks print, and leave prose, numbers and
 * URLs alone (the web-links addon keeps the URLs).
 */
import { describe, it, expect } from 'vitest';
import { findTerminalPathLinks, logicalLineAt, pathLinksAtRow, resolveTerminalPath } from '@/components/sessions/terminal-links';

const paths = (line: string) => findTerminalPathLinks(line).map((l) => ({ path: l.path, line: l.line, col: l.col, text: line.slice(l.start, l.end) }));

describe('terminal path links', () => {
  it('finds compiler and test runner positions', () => {
    expect(paths('src/web/server.ts:42:7 - error TS2322: Type')).toEqual([{ path: 'src/web/server.ts', line: 42, col: 7, text: 'src/web/server.ts:42:7' }]);
    expect(paths(' FAIL  tests/web/x.test.ts > a > b')).toEqual([{ path: 'tests/web/x.test.ts', line: undefined, col: undefined, text: 'tests/web/x.test.ts' }]);
    expect(paths('    at foo (/Users/me/app/index.js:10:15)')).toEqual([{ path: '/Users/me/app/index.js', line: 10, col: 15, text: '/Users/me/app/index.js:10:15' }]);
    expect(paths('main.go:12: undefined: x')[0]).toMatchObject({ path: 'main.go', line: 12 });
    expect(paths('Program.cs(12,5): error CS1002')[0]).toMatchObject({ path: 'Program.cs', line: 12, col: 5 });
  });

  it('finds a Python traceback line', () => {
    expect(paths('  File "/home/u/proj/app.py", line 88, in main')).toEqual([{ path: '/home/u/proj/app.py', line: 88, col: undefined, text: '/home/u/proj/app.py", line 88' }]);
  });

  it('finds ls and git output', () => {
    expect(paths('package.json  README.md  src/').map((p) => p.path)).toEqual(['package.json', 'README.md']);
    expect(paths('diff --git a/web/src/x.ts b/web/src/x.ts').map((p) => p.path)).toEqual(['web/src/x.ts', 'web/src/x.ts']);
    expect(paths('+++ b/src/a.ts')[0]).toMatchObject({ path: 'src/a.ts', text: 'src/a.ts' });
    expect(paths('	modified:   web/src/styles/globals.css')[0]).toMatchObject({ path: 'web/src/styles/globals.css' });
  });

  it('finds absolute, home and dot paths, and folders', () => {
    expect(paths('cd ~/work/walnut/web').map((p) => p.path)).toEqual(['~/work/walnut/web']);
    expect(paths('wrote /tmp/out/report.html.').map((p) => p.path)).toEqual(['/tmp/out/report.html']);
    expect(paths('see ./scripts/run.sh and ../README.md').map((p) => p.path)).toEqual(['./scripts/run.sh', '../README.md']);
    expect(paths('#L form: src/a.ts#L30')[0]).toMatchObject({ path: 'src/a.ts', line: 30 });
  });

  it('leaves prose, numbers, versions and slashes between words alone', () => {
    expect(paths('read/write and/or 3/4 done in 1.5s at 12:30, v1.2.3')).toEqual([]);
    expect(paths('Tests  12 passed (12)')).toEqual([]);
    expect(paths('e.g. node.js is fine / ok')).toEqual([]);
    expect(paths('/')).toEqual([]);
    expect(paths('   ')).toEqual([]);
  });

  it('never makes a path link inside a URL', () => {
    expect(paths('open http://localhost:5173/src/main.tsx now')).toEqual([]);
    expect(paths('https://github.com/x/y/blob/main/src/a.ts and src/b.ts').map((p) => p.path)).toEqual(['src/b.ts']);
  });

  it('gives positions as string indexes, past wide characters', () => {
    const line = '\u6587\u4ef6 src/a.ts:3';
    const [l] = findTerminalPathLinks(line);
    expect(line.slice(l!.start, l!.end)).toBe('src/a.ts:3');
  });
});

describe('terminal links over buffer rows', () => {
  /** A fake xterm buffer: rows of cells; `wrapped` marks a row a long line wrapped onto. */
  function buffer(rows: { text: string; wrapped?: boolean }[]) {
    return {
      getLine(y: number) {
        const r = rows[y];
        if (!r) return undefined;
        // One cell per code point; a CJK character takes two cells (the second has width 0).
        const cells: { chars: string; width: number }[] = [];
        for (const ch of r.text) {
          const wide = /[\u3000-\u9fff]/.test(ch);
          cells.push({ chars: ch, width: wide ? 2 : 1 });
          if (wide) cells.push({ chars: '', width: 0 });
        }
        return {
          isWrapped: !!r.wrapped,
          length: cells.length,
          getCell: (x: number) => (cells[x] ? { getChars: () => cells[x]!.chars, getWidth: () => cells[x]!.width } : undefined),
        };
      },
    };
  }

  it('maps a path back to its cells, past wide characters', () => {
    const b = buffer([{ text: '\u6587\u4ef6 src/a.ts:3 ok' }]);
    const [l] = pathLinksAtRow(b, 0);
    expect(l!.text).toBe('src/a.ts:3');
    // Two wide characters (4 cells) and a space: the path starts at cell 6 (1-based).
    expect(l!.start).toEqual({ x: 6, y: 1 });
    expect(l!.end).toEqual({ x: 15, y: 1 });
  });

  it('finds a path a long line wrapped across two rows, from either row', () => {
    const b = buffer([{ text: 'error in web/src/compo' }, { text: 'nents/x.tsx:12 here', wrapped: true }]);
    for (const row of [0, 1]) {
      const links = pathLinksAtRow(b, row);
      expect(links.map((l) => [l.link.path, l.link.line, l.start, l.end])).toEqual([
        ['web/src/components/x.tsx', 12, { x: 10, y: 1 }, { x: 14, y: 2 }],
      ]);
    }
    expect(logicalLineAt(b, 1).text).toBe('error in web/src/components/x.tsx:12 here');
  });

  it('keeps only the links that cross the asked row', () => {
    const b = buffer([{ text: 'a/b/c.ts' }, { text: 'nothing here' }]);
    expect(pathLinksAtRow(b, 1)).toEqual([]);
    expect(pathLinksAtRow(b, 0)).toHaveLength(1);
  });
});

describe('terminal links: assignments and dates', () => {
  it('an env assignment or a flag links the path after the =, not the whole word', () => {
    expect(findTerminalPathLinks('PATH=/usr/local/bin').map((l) => l.path)).toEqual(['/usr/local/bin']);
    expect(findTerminalPathLinks('vitest --config=vitest.config.ts').map((l) => l.path)).toEqual(['vitest.config.ts']);
  });

  it('a date is not a path', () => {
    expect(findTerminalPathLinks('built 11/08/2026 at 12:30')).toEqual([]);
    expect(findTerminalPathLinks('2026-11-08')).toEqual([]);
  });
});

describe('terminal links: quoted names with spaces', () => {
  it('links a quoted path with spaces, with its position, as one link', () => {
    const text = 'see "review/with space.ts":11 and \'docs/my notes.md\'';
    const links = findTerminalPathLinks(text);
    expect(links.map((l) => [l.path, l.line, text.slice(l.start, l.end)])).toEqual([
      ['review/with space.ts', 11, '"review/with space.ts":11'],
      ['docs/my notes.md', undefined, "'docs/my notes.md'"],
    ]);
    const py = findTerminalPathLinks('  File "/srv/my app/main.py", line 8, in <module>');
    expect(py.map((l) => [l.path, l.line])).toEqual([['/srv/my app/main.py', 8]]);
  });

  it('a quoted sentence is not a path, though a path inside it still is', () => {
    const links = findTerminalPathLinks("echo 'see pwdemo/app.ts:27 for it'");
    expect(links.map((l) => [l.path, l.line])).toEqual([['pwdemo/app.ts', 27]]);
    expect(findTerminalPathLinks('"hello there friend"')).toEqual([]);
  });
});

describe('terminal links: a relative path from the shell directory', () => {
  it('joins and folds . and ..; an absolute or home path stays', () => {
    expect(resolveTerminalPath('/repo/web', 'src/a.ts')).toBe('/repo/web/src/a.ts');
    expect(resolveTerminalPath('/repo/web', './x/../b.ts')).toBe('/repo/web/b.ts');
    expect(resolveTerminalPath('/repo/web', '../../../up.ts')).toBe('/up.ts');
    expect(resolveTerminalPath('/repo', '/etc/hosts')).toBe('/etc/hosts');
    expect(resolveTerminalPath('/repo', '~/x.ts')).toBe('~/x.ts');
  });
});

describe('terminal links: names in any script, files without an extension', () => {
  it('links a path with non-ASCII parts, the whole of it', () => {
    // "docs/<report in Chinese>/app.ts:2"
    const text = 'see review/报告/app.ts:2 now';
    const links = findTerminalPathLinks(text);
    expect(links.map((l) => [l.path, l.line])).toEqual([['review/报告/app.ts', 2]]);
    expect(findTerminalPathLinks('café/menü.md').map((l) => l.path)).toEqual(['café/menü.md']);
  });

  it('links files known by name, dotfiles, and a two-part path with a line', () => {
    expect(findTerminalPathLinks('Makefile:1 and review/README').map((l) => [l.path, l.line])).toEqual([['Makefile', 1], ['review/README', undefined]]);
    expect(findTerminalPathLinks('edit .env then bin/run:12').map((l) => [l.path, l.line])).toEqual([['.env', undefined], ['bin/run', 12]]);
    expect(findTerminalPathLinks('Dockerfile').map((l) => l.path)).toEqual(['Dockerfile']);
  });

  it('still leaves prose alone', () => {
    expect(findTerminalPathLinks('read and/or write, Note:3, at 12:30, v1.2.3')).toEqual([]);
  });
});

describe('terminal links: where a relative path is looked for', () => {
  it('from the shell, then its repository root, then as printed; a git diff path from the root first', async () => {
    const { terminalPathCandidates } = await import('@/components/sessions/terminal-links');
    const lint = findTerminalPathLinks('lint: src/app.ts:5:2')[0]!;
    expect(terminalPathCandidates(lint, { cwd: '/w/proj/sub', root: '/w/proj' })).toEqual(['/w/proj/sub/src/app.ts', '/w/proj/src/app.ts', 'src/app.ts']);
    const diff = findTerminalPathLinks('+++ b/src/app.ts')[0]!;
    expect(diff).toMatchObject({ path: 'src/app.ts', fromRepoRoot: true });
    expect(terminalPathCandidates(diff, { cwd: '/w/proj/sub', root: '/w/proj' })).toEqual(['/w/proj/src/app.ts', '/w/proj/sub/src/app.ts', 'src/app.ts']);
    // No answer from the host: as printed. An absolute path: only itself.
    expect(terminalPathCandidates(lint, { cwd: null })).toEqual(['src/app.ts']);
    expect(terminalPathCandidates(findTerminalPathLinks('/etc/hosts:2')[0]!, { cwd: '/w', root: '/w' })).toEqual(['/etc/hosts']);
    // The shell at the repository root: one place, not two.
    expect(terminalPathCandidates(lint, { cwd: '/w/proj', root: '/w/proj' })).toEqual(['/w/proj/src/app.ts', 'src/app.ts']);
  });
});

describe('terminal links: dot folders and . / .. parts', () => {
  it('links the whole path through dot folders, ./ and ../ parts', async () => {
    const { terminalPathCandidates } = await import('@/components/sessions/terminal-links');
    const paths = (t: string) => findTerminalPathLinks(t).map((l) => [l.path, l.line ?? null]);
    expect(paths('see /home/u/.cfgdir/a.json:4')).toEqual([['/home/u/.cfgdir/a.json', 4]]);
    expect(paths('~/.zshrc')).toEqual([['~/.zshrc', null]]);
    expect(paths('../../top.md:2')).toEqual([['../../top.md', 2]]);
    expect(paths('../../packages/x.ts(12,5): error')).toEqual([['../../packages/x.ts', 12]]);
    expect(paths('web/.storybook/main.ts:4')).toEqual([['web/.storybook/main.ts', 4]]);
    expect(paths('node_modules/.bin/vite')).toEqual([['node_modules/.bin/vite', null]]);
    const py = findTerminalPathLinks('  File "/a/src/../big.txt", line 200')[0]!;
    expect([py.path, py.line]).toEqual(['/a/src/../big.txt', 200]);
    expect(terminalPathCandidates(py, { cwd: '/x' })).toEqual(['/a/big.txt']);
  });

  it('a sentence ending in dots is still not a path', () => {
    expect(findTerminalPathLinks('wait... then go. ok..')).toEqual([]);
  });
});

describe('terminal links: an unexpanded $HOME', () => {
  it('reads $HOME/ and ${HOME}/ as the home folder', () => {
    const links = findTerminalPathLinks('see $HOME/r5/.hidden/dot.ts:2 and ${HOME}/x/y.md');
    expect(links.map((l) => [l.path, l.line ?? null])).toEqual([['~/r5/.hidden/dot.ts', 2], ['~/x/y.md', null]]);
    expect(links[0]!.start).toBe(4); // the link covers $HOME too
    expect(findTerminalPathLinks('cost $5/month')).toEqual([]);
  });
});
