/**
 * Layered path resolution — the "cwd is A/, model wrote 1/2/3, file is at
 * A/B/C/1/2/3" family of failures.
 *
 * Every test builds a real temp tree (and real git repos where the git layer is
 * under test) because each layer's whole point is talking to a real filesystem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const { resolvePathHostLocal } = await import('../../src/providers/path-resolve-core.js');

let tmp: string;

/** mkdir -p + write, so a test declares a tree in one line per file. */
async function writeFile(rel: string, content = 'x\n'): Promise<string> {
  const abs = path.join(tmp, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
    },
  });
}

/** Init a repo at `dir` and commit everything under it. */
function initRepo(dir: string): void {
  git(['init', '-q'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'init'], dir);
}

/** A session transcript containing one assistant tool_use on `filePath`. */
async function writeTranscript(claudeHome: string, cwd: string, sid: string, filePath: string): Promise<void> {
  const encoded = cwd.replace(/[/.]/g, '-');
  const dir = path.join(claudeHome, 'projects', encoded);
  await fs.mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    type: 'assistant',
    cwd,
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: filePath } }] },
  });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), line + '\n');
}

beforeEach(async () => {
  // realpath: macOS /var → /private/var, and the resolver returns real paths.
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-pathres-')));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('L0 exact', () => {
  it('returns an absolute path that exists, untouched', async () => {
    const abs = await writeFile('A/B/C/1/2/3.ts');
    const res = await resolvePathHostLocal({ ref: abs, cwd: tmp });
    expect(res).toMatchObject({ path: abs, resolved: true, via: 'exact' });
  });

  it('joins a relative ref that exists directly under cwd', async () => {
    await writeFile('A/one.ts');
    const res = await resolvePathHostLocal({ ref: 'one.ts', cwd: path.join(tmp, 'A') });
    expect(res).toMatchObject({ path: path.join(tmp, 'A', 'one.ts'), resolved: true, via: 'exact' });
  });

  it('expands a leading ~ against the supplied home dir', async () => {
    const abs = await writeFile('home/notes/todo.md');
    const res = await resolvePathHostLocal({ ref: '~/notes/todo.md', homeDir: path.join(tmp, 'home') });
    expect(res).toMatchObject({ path: abs, resolved: true, via: 'exact' });
  });
});

describe('L1 transcript', () => {
  it('resolves a relative ref from a path the session already opened', async () => {
    // THE reported bug: cwd is A/, the model writes 1/2/3, the file is deeper.
    const target = await writeFile('A/B/C/1/2/3.ts');
    const cwd = path.join(tmp, 'A');
    const claudeHome = path.join(tmp, '.claude');
    await writeTranscript(claudeHome, cwd, 'sid-1', target);

    const res = await resolvePathHostLocal({ ref: '1/2/3.ts', cwd, sessionId: 'sid-1', claudeHome });
    expect(res).toMatchObject({ path: target, resolved: true, via: 'transcript' });
  });

  it('fixes a WRONG absolute prefix by matching the tail (no other layer can)', async () => {
    const target = await writeFile('real/root/pkg/svc/handler.go');
    const cwd = path.join(tmp, 'real', 'root');
    const claudeHome = path.join(tmp, '.claude');
    await writeTranscript(claudeHome, cwd, 'sid-2', target);

    const res = await resolvePathHostLocal({
      ref: '/wrong/checkout/pkg/svc/handler.go',
      cwd, sessionId: 'sid-2', claudeHome,
    });
    expect(res).toMatchObject({ path: target, resolved: true, via: 'transcript' });
  });

  it('ignores transcript paths that no longer exist and falls through', async () => {
    const cwd = path.join(tmp, 'A');
    await fs.mkdir(cwd, { recursive: true });
    const claudeHome = path.join(tmp, '.claude');
    await writeTranscript(claudeHome, cwd, 'sid-3', path.join(tmp, 'A/deleted/gone.ts'));

    const res = await resolvePathHostLocal({ ref: 'deleted/gone.ts', cwd, sessionId: 'sid-3', claudeHome });
    expect(res.resolved).toBe(false);
    expect(res.via).not.toBe('transcript');
  });
});

describe('L2 walk-up', () => {
  it('finds a repo-root-relative path while cwd sits in a subdirectory', async () => {
    const target = await writeFile('repo/docs/design.md');
    const res = await resolvePathHostLocal({ ref: 'docs/design.md', cwd: path.join(tmp, 'repo/src/deep') });
    // cwd need not exist — the walk-up bases are still its ancestors.
    expect(res).toMatchObject({ path: target, resolved: true, via: 'walk-up' });
  });
});

describe('L3 git index', () => {
  it('finds a deep path from a shallow cwd (the reported failure)', async () => {
    const target = await writeFile('repo/A/B/C/1/2/3.ts');
    initRepo(path.join(tmp, 'repo'));

    const res = await resolvePathHostLocal({ ref: '1/2/3.ts', cwd: path.join(tmp, 'repo/A') });
    expect(res).toMatchObject({ path: target, resolved: true, via: 'git' });
  });

  it('reaches into a submodule from the superproject', async () => {
    const sub = path.join(tmp, 'sub');
    await writeFile('sub/pkg/informers/informers.go');
    initRepo(sub);

    const outer = path.join(tmp, 'outer');
    await writeFile('outer/README.md');
    initRepo(outer);
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendored'], outer);
    git(['commit', '-qm', 'add submodule'], outer);

    // cwd is the SUPERPROJECT: only --recurse-submodules can see the file.
    const res = await resolvePathHostLocal({ ref: 'pkg/informers/informers.go', cwd: outer });
    expect(res.resolved).toBe(true);
    expect(res.path).toBe(path.join(outer, 'vendored/pkg/informers/informers.go'));
  });

  it('resolves an extensionless DIRECTORY reference', async () => {
    await writeFile('repo/acme/ledger/api/main.go');
    initRepo(path.join(tmp, 'repo'));

    const res = await resolvePathHostLocal({ ref: 'acme/ledger/api', cwd: path.join(tmp, 'repo') });
    expect(res).toMatchObject({ path: path.join(tmp, 'repo/acme/ledger/api'), resolved: true });
  });

  it('prefers the shallowest match when a basename repeats, and reports the rest', async () => {
    // Neither copy sits at cwd/rel or any ancestor/rel, so the walk-up layer
    // misses and the git layer does the choosing.
    await writeFile('repo/one/util/index.ts');
    await writeFile('repo/a/b/two/util/index.ts');
    initRepo(path.join(tmp, 'repo'));

    const res = await resolvePathHostLocal({ ref: 'util/index.ts', cwd: path.join(tmp, 'repo') });
    expect(res.via).toBe('git');
    expect(res.path).toBe(path.join(tmp, 'repo/one/util/index.ts'));
    expect(res.alternatives).toContain(path.join(tmp, 'repo/a/b/two/util/index.ts'));
  });
});

describe('L4 find (untracked / non-git)', () => {
  it('finds a deep untracked file in a tree with no git repo', async () => {
    const target = await writeFile('plain/A/B/C/1/2/3.ts');
    const res = await resolvePathHostLocal({ ref: '1/2/3.ts', cwd: path.join(tmp, 'plain') });
    expect(res).toMatchObject({ path: target, resolved: true, via: 'find' });
  });

  it('never returns a hit from inside node_modules', async () => {
    await writeFile('plain/node_modules/dep/lib/widget.ts');
    const res = await resolvePathHostLocal({ ref: 'lib/widget.ts', cwd: path.join(tmp, 'plain') });
    expect(res.resolved).toBe(false);
  });
});

describe('L5 suffix retry', () => {
  it('resolves a VERY deep absolute ref without exhausting its budget', async () => {
    // Regression: every suffix of an absolute path used to be searched, so a
    // deep monorepo ref (~15 suffixes × repo roots) spent the whole budget on
    // long tails that can never match and gave up before the short ones.
    const deep = 'repo/a/b/c/d/e/f/g/h/tools/heapchain/census.go';
    const target = await writeFile(deep);
    initRepo(path.join(tmp, 'repo'));

    const res = await resolvePathHostLocal({
      // Same tail, wrong (long) prefix — the shape a quoted path arrives in.
      ref: '/some/other/root/x/y/z/q/w/tools/heapchain/census.go',
      cwd: path.join(tmp, 'repo'),
    });
    expect(res.resolved).toBe(true);
    expect(res.path).toBe(target);
  });

  it('drops extra leading segments that do not exist here', async () => {
    const target = await writeFile('repo/src/web/routes/files.ts');
    initRepo(path.join(tmp, 'repo'));

    // A quoted ref carrying a foreign root prefix.
    const res = await resolvePathHostLocal({
      ref: 'someone-elses-checkout/src/web/routes/files.ts',
      cwd: path.join(tmp, 'repo'),
    });
    expect(res).toMatchObject({ path: target, resolved: true });
  });
});

describe('L6 degraded fallback', () => {
  it('returns the deepest existing ancestor instead of a missing path', async () => {
    await fs.mkdir(path.join(tmp, 'repo/src'), { recursive: true });
    const res = await resolvePathHostLocal({
      ref: 'src/nope/never/absent.ts',
      cwd: path.join(tmp, 'repo'),
    });
    expect(res).toMatchObject({ resolved: false, via: 'ancestor', degraded: true, ref: 'src/nope/never/absent.ts' });
    // Something a directory listing can actually show.
    expect(res.path).toBe(path.join(tmp, 'repo/src'));
  });

  it('degrades with no cwd at all', async () => {
    const res = await resolvePathHostLocal({ ref: path.join(tmp, 'a/b/c/missing.ts') });
    expect(res.resolved).toBe(false);
    expect(res.path).toBe(tmp);
  });
});

describe('input guards', () => {
  it.each(['../escape.ts', 'a/$(whoami)/b.ts', 'a/`id`/b.ts', 'a;rm -rf b/c.ts', ''])(
    'rejects %j', async (ref) => {
      await expect(resolvePathHostLocal({ ref, cwd: tmp })).rejects.toThrow(/Invalid path/);
    },
  );

  it('rejects an unsafe cwd by ignoring it, never by searching it', async () => {
    // cwd with metacharacters is dropped; the ref alone can't resolve.
    const res = await resolvePathHostLocal({ ref: 'x/y.ts', cwd: '/tmp/$(id)' });
    expect(res.resolved).toBe(false);
  });
});

describe('budget', () => {
  it('degrades instead of hanging when the budget is already spent', async () => {
    await writeFile('repo/A/B/C/1/2/3.ts');
    initRepo(path.join(tmp, 'repo'));
    const res = await resolvePathHostLocal({
      ref: '1/2/3.ts', cwd: path.join(tmp, 'repo/A'), budgetMs: 0,
    });
    expect(res.resolved).toBe(false);
    expect(res.degraded).toBe(true);
  });
});
