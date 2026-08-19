/**
 * The awkward-input matrix for path resolution.
 *
 * One real tree containing every shape that broke the resolver during development,
 * then one assertion per shape. Companion to path-resolve-core.test.ts, which
 * covers the LAYERS; this file covers the INPUTS and the honesty of the answer.
 *
 * The two rules these pin hardest, because both were real bugs:
 *  - a decorated reference (`\`a.ts:42\``) must find the file AND report the line;
 *  - a reference that names a path which does not exist must NOT be "resolved" to
 *    some unrelated file that happens to share a basename. A confident wrong answer
 *    is worse than an error, because the user opens it believing it is right.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const { resolvePathHostLocal } = await import('../../src/providers/path-resolve-core.js');

let tmp: string;
let R: string;   // the repo root inside tmp

async function W(rel: string, content = 'x\n'): Promise<string> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

// One tree for the whole file: building it per-test would run git init dozens of
// times for no added coverage.
beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-pathedge-')));
  R = path.join(tmp, 'repo');

  await W('repo/src/web/routes/files.ts');
  await W('repo/src/deep/a/b/c/target.ts');
  await W('repo/src/util/Helper.ts');                    // case matters here
  await W('repo/Makefile');                              // extensionless FILE
  await W('repo/Dockerfile');
  await W('repo/LICENSE');
  await W('repo/.gitignore', 'ignored/\n.env\n');
  await W('repo/.env', 'SECRET=1\n');                    // gitignored
  await W('repo/ignored/thing.js');                      // gitignored dir
  await W('repo/.claude/settings.json');                 // dot-named dir
  await fs.mkdir(path.join(R, '.claude/agents'), { recursive: true });
  await W('repo/docs/My Notes/H1 2026 Overview.md');     // spaces
  await W('repo/docs/中文目录/说明文件.md');                // CJK
  await W('repo/pkg/mod..old/thing.ts');                 // dots in a NAME
  await W('repo/very/deep/x1/x2/x3/x4/x5/x6/x7/leaf.ts'); // deeper than find depth
  await W('repo/other/lonely.ts');                       // for the false-positive test

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
  };
  execFileSync('git', ['init', '-q'], { cwd: R, stdio: 'ignore', env });
  execFileSync('git', ['add', '-A'], { cwd: R, stdio: 'ignore', env });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: R, stdio: 'ignore', env });

  // Untracked AFTER the commit — only `find` can see these.
  await W('repo/brand/new/uncommitted.ts');
  // A symlinked cwd, to pin real-path normalization.
  await fs.symlink(path.join(R, 'src'), path.join(tmp, 'srclink'), 'dir');
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Resolve against the repo root with a generous-but-bounded budget. */
const resolve = (ref: string, cwd = R) =>
  resolvePathHostLocal({ ref, cwd, budgetMs: 10_000 });

describe('decorated references still find the file', () => {
  it.each([
    ['bare', 'routes/files.ts', undefined],
    ['line', 'routes/files.ts:42', 42],
    ['line:col', 'routes/files.ts:42:7', 42],
    ['github anchor', 'routes/files.ts#L42', 42],
    ['range', 'routes/files.ts:10-20', 10],
    ['paren position', 'routes/files.ts(42)', 42],
    ['prose position', 'routes/files.ts, line 42', 42],
    ['backticks', '`routes/files.ts`', undefined],
    ['backticks + line', '`routes/files.ts:42`', 42],
    ['double quotes', '"routes/files.ts"', undefined],
    ['angle brackets', '<routes/files.ts>', undefined],
    ['trailing period', 'routes/files.ts.', undefined],
    ['trailing comma', 'routes/files.ts,', undefined],
    ['list marker', '- routes/files.ts', undefined],
    ['windows separators', 'src\\web\\routes\\files.ts', undefined],
    ['duplicate slashes', 'src//web///routes//files.ts', undefined],
  ])('%s', async (_label, ref, wantLine) => {
    const res = await resolve(ref);
    expect(res.resolved).toBe(true);
    expect(res.path).toBe(path.join(R, 'src/web/routes/files.ts'));
    expect(res.line).toBe(wantLine);
  });
});

describe('extensionless names', () => {
  it.each(['Makefile', 'Dockerfile', 'LICENSE'])('finds the FILE %s', async (name) => {
    const res = await resolve(name);
    expect(res).toMatchObject({ path: path.join(R, name), resolved: true });
  });

  it('finds a dot-named DIRECTORY', async () => {
    const res = await resolve('.claude/agents');
    expect(res).toMatchObject({ path: path.join(R, '.claude/agents'), resolved: true });
  });

  it('finds an extensionless file from a subdirectory cwd', async () => {
    // Not reachable by walk-up-then-join alone: needs the file pathspec that the
    // directory-shaped guess would otherwise have skipped.
    const res = await resolve('Makefile', path.join(R, 'src/web/routes'));
    expect(res).toMatchObject({ path: path.join(R, 'Makefile'), resolved: true });
  });
});

describe('paths git cannot see', () => {
  it('finds a gitignored file', async () => {
    const res = await resolve('.env');
    expect(res).toMatchObject({ path: path.join(R, '.env'), resolved: true });
  });

  it('finds a file inside a gitignored directory', async () => {
    const res = await resolve('ignored/thing.js');
    expect(res).toMatchObject({ path: path.join(R, 'ignored/thing.js'), resolved: true });
  });

  it('finds an untracked file via find', async () => {
    const res = await resolve('brand/new/uncommitted.ts');
    expect(res).toMatchObject({ path: path.join(R, 'brand/new/uncommitted.ts'), resolved: true });
  });
});

describe('awkward characters', () => {
  it('handles spaces in every segment', async () => {
    const res = await resolve('My Notes/H1 2026 Overview.md');
    expect(res).toMatchObject({
      path: path.join(R, 'docs/My Notes/H1 2026 Overview.md'), resolved: true,
    });
  });

  it('handles CJK segments', async () => {
    const res = await resolve('中文目录/说明文件.md');
    expect(res).toMatchObject({
      path: path.join(R, 'docs/中文目录/说明文件.md'), resolved: true,
    });
  });

  it('handles dots inside a segment name (not traversal)', async () => {
    const res = await resolve('mod..old/thing.ts');
    expect(res).toMatchObject({ path: path.join(R, 'pkg/mod..old/thing.ts'), resolved: true });
  });

  it('still refuses a real traversal segment', async () => {
    await expect(resolve('../escape.ts')).rejects.toThrow(/Invalid path/);
    await expect(resolve('src/../../escape.ts')).rejects.toThrow(/Invalid path/);
  });
});

describe('case mismatch', () => {
  it('recovers a mis-cased leaf', async () => {
    const res = await resolve('util/helper.ts');
    expect(res.resolved).toBe(true);
    expect(res.path).toBe(path.join(R, 'src/util/Helper.ts'));
  });

  it('prefers the exactly-cased file when both exist', async () => {
    // Only meaningful on a case-SENSITIVE filesystem. A default macOS volume folds
    // case, so the two writes below are one file and there is nothing to choose
    // between; detect that rather than asserting something the platform prevents.
    await W('repo/casing/Thing.ts', 'upper\n');
    await W('repo/casing/thing.ts', 'lower\n');
    const entries = await fs.readdir(path.join(R, 'casing'));
    if (entries.length < 2) return; // case-folding volume: nothing to disambiguate

    const res = await resolve('casing/thing.ts');
    expect(res.path).toBe(path.join(R, 'casing/thing.ts'));
    expect(res.via).not.toBe('case-insensitive');
  });
});

describe('depth', () => {
  it('finds a file deeper than the find-depth cap (git index has no depth limit)', async () => {
    const res = await resolve('x6/x7/leaf.ts');
    expect(res).toMatchObject({
      path: path.join(R, 'very/deep/x1/x2/x3/x4/x5/x6/x7/leaf.ts'), resolved: true,
    });
  });
});

describe('symlinked cwd', () => {
  it('returns the REAL path, not the link-relative one', async () => {
    // Two "absolute" paths for one file would split the Files panel's per-path
    // memory, so the resolver normalizes the cwd once and speaks in real paths.
    const res = await resolve('web/routes/files.ts', path.join(tmp, 'srclink'));
    expect(res.resolved).toBe(true);
    expect(res.path).toBe(path.join(R, 'src/web/routes/files.ts'));
    expect(res.path).not.toContain('srclink');
  });
});

describe('honesty — never a confident wrong answer', () => {
  it('refuses to match only the basename when the ref named a directory too', async () => {
    // THE bug this pins: `no/such/lonely.ts` used to "resolve" to other/lonely.ts,
    // reporting resolved:true. Opening the wrong file while believing it is the
    // right one is worse than being told it could not be found.
    const res = await resolve('no/such/lonely.ts');
    expect(res.resolved).toBe(false);
    expect(res.path).not.toBe(path.join(R, 'other/lonely.ts'));
  });

  it('DOES match a bare filename, which has no context to preserve', async () => {
    const res = await resolve('lonely.ts');
    expect(res).toMatchObject({ path: path.join(R, 'other/lonely.ts'), resolved: true });
  });

  it('keeps one directory of context when trimming a long reference', async () => {
    // `routes/files.ts` survives; a wrong parent does not silently pass.
    await expect(resolve('routes/files.ts')).resolves.toMatchObject({ resolved: true });
    await expect(resolve('bogus/files.ts')).resolves.toMatchObject({ resolved: false });
  });

  it('reports the position even on a degraded answer', async () => {
    // The line is what the reference asked for; failing to find the file does not
    // make it unknown, and the caller may still want to show it.
    const res = await resolve('no/such/place/absent.ts:99');
    expect(res).toMatchObject({ resolved: false, degraded: true, line: 99 });
  });

  it('degrades to a real directory rather than an errno', async () => {
    const res = await resolve('src/web/nope/never/here');
    expect(res.resolved).toBe(false);
    expect(res.degraded).toBe(true);
    // Something a directory listing can actually show.
    expect(res.path).toBe(path.join(R, 'src/web'));
  });
});
